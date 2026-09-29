import { describe, it, expect, vi } from 'vitest';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

import { toFloat16Bits, fromFloat16Bits } from '@/process-transcript/windows/float16';
import { buildSentences } from '@/process-transcript/windows/sentences';
import { buildWindows, MAX_WINDOW_CHARS } from '@/process-transcript/windows/build-windows';
import { createWindowsFile, decodeWindowsFile, writeVector } from '@/process-transcript/windows/encode';
import { planBatches, MAX_BATCH_INPUTS, MAX_BATCH_CHARS } from '@/process-transcript/windows/embed';
import {
  writeWindowsFile,
  windowsKey,
  windowsObjectMetadata,
} from '@/process-transcript/windows/write-windows';
import type { TranscriptSegment } from '@/process-transcript/types';

function seg(start: number, end: number, transcript: string, id = String(start)): TranscriptSegment {
  return {
    id,
    start_time: start.toFixed(3),
    end_time: end.toFixed(3),
    transcript,
    speaker_label: 'spk_0',
  };
}

describe('toFloat16Bits', () => {
  it.each([
    [0, 0x0000],
    [1, 0x3c00],
    [-2, 0xc000],
    [0.5, 0x3800],
    [65504, 0x7bff],
    [1e-8, 0x0000],
    [100000, 0x7c00],
  ])('encodes %d as %s', (value, bits) => {
    expect(toFloat16Bits(value)).toBe(bits);
  });

  it('round-trips through fromFloat16Bits within float16 precision', () => {
    for (const value of [0.123, -0.456, 0.001, 0.75]) {
      expect(fromFloat16Bits(toFloat16Bits(value))).toBeCloseTo(value, 3);
    }
  });
});

describe('buildSentences', () => {
  it('skips empty text and unparseable times', () => {
    const sentences = buildSentences([
      seg(0, 2, 'one'),
      seg(2, 4, '   '),
      { ...seg(4, 6, 'bad'), start_time: 'x' },
      seg(6, 8, 'two'),
    ]);
    expect(sentences.map((s) => s.text)).toEqual(['one', 'two']);
  });

  it('removes duplicates by start_time and transcript', () => {
    const sentences = buildSentences([seg(0, 2, 'one'), seg(0, 2, 'one', 'dup'), seg(0, 2, 'other')]);
    expect(sentences.map((s) => s.text)).toEqual(['one', 'other']);
  });

  it('sorts by start and keeps input order for equal starts', () => {
    const sentences = buildSentences([seg(5, 6, 'late'), seg(1, 2, 'a'), seg(1, 3, 'b')]);
    expect(sentences.map((s) => s.text)).toEqual(['a', 'b', 'late']);
  });
});

describe('buildWindows', () => {
  const sentences = buildSentences([
    seg(0, 4, 's0'),
    seg(4, 8, 's1'),
    seg(8, 12, 's2'),
    seg(12, 16, 's3'),
  ]);

  it('makes one window per sentence', () => {
    expect(buildWindows(sentences, 10)).toHaveLength(sentences.length);
  });

  it('includes the sentence that reaches the length', () => {
    const [first] = buildWindows(sentences, 10);
    // 0 -> 8 is short of 10; sentence 2 ends at 12 and is included.
    expect(first).toMatchObject({ startIndex: 0, endIndex: 2, start: 0, end: 12, text: 's0 s1 s2' });
  });

  it('runs the last windows to the final sentence', () => {
    const windows = buildWindows(sentences, 10);
    expect(windows[2]).toMatchObject({ startIndex: 2, endIndex: 3, end: 16 });
    expect(windows[3]).toMatchObject({ startIndex: 3, endIndex: 3, end: 16 });
  });

  it('truncates long text', () => {
    const long = buildSentences([seg(0, 20, 'x'.repeat(MAX_WINDOW_CHARS + 50))]);
    expect(buildWindows(long, 10)[0].text).toHaveLength(MAX_WINDOW_CHARS);
  });
});

describe('createWindowsFile / decodeWindowsFile', () => {
  it('round-trips the header, table and vectors', () => {
    const file = createWindowsFile({
      embeddingModel: 'text-embedding-3-small',
      embeddingDim: 4,
      windowSecs: [10, 30],
      transcriptSha256: 'abc',
      generatedAt: '2026-09-29T00:00:00.000Z',
      table: [
        { sentStart: 0, sentEnd: 2.5, windowEnds: [10.25, 31] },
        { sentStart: 2.5, sentEnd: 5, windowEnds: [12, 33.5] },
      ],
    });
    writeVector(file, 0, 0, [0.5, -0.25, 0, 1]);
    writeVector(file, 0, 1, [0.125, 0.25, 0.375, 0.5]);
    writeVector(file, 1, 0, [-1, -0.5, 0.5, 1]);
    writeVector(file, 1, 1, [0, 0, 0, 0.0625]);

    expect(file.buffer.toString('ascii', 0, 4)).toBe('PWIN');
    expect(file.header.tableOffset % 8).toBe(0);
    expect(file.header.rowsOffset).toBe(file.header.tableOffset + 2 * 32);
    expect(file.header.rowBytes).toBe(2 * 4 * 2);
    expect(file.buffer.length).toBe(file.header.rowsOffset + 2 * file.header.rowBytes);

    const decoded = decodeWindowsFile(file.buffer);
    expect(decoded.header).toEqual(file.header);
    expect(decoded.table).toEqual([
      { sentStart: 0, sentEnd: 2.5, windowEnds: [10.25, 31] },
      { sentStart: 2.5, sentEnd: 5, windowEnds: [12, 33.5] },
    ]);
    expect(decoded.vectors[0]).toEqual([
      [0.5, -0.25, 0, 1],
      [-1, -0.5, 0.5, 1],
    ]);
    expect(decoded.vectors[1]).toEqual([
      [0.125, 0.25, 0.375, 0.5],
      [0, 0, 0, 0.0625],
    ]);
  });

  it('rejects a vector of the wrong length', () => {
    const file = createWindowsFile({
      embeddingModel: 'm',
      embeddingDim: 4,
      windowSecs: [10, 30],
      transcriptSha256: 'abc',
      generatedAt: '2026-09-29T00:00:00.000Z',
      table: [{ sentStart: 0, sentEnd: 1, windowEnds: [1, 1] }],
    });
    expect(() => writeVector(file, 0, 0, [1, 2])).toThrow(/expected 4 values/);
  });
});

describe('planBatches', () => {
  it('splits on the input limit', () => {
    const texts = Array.from({ length: MAX_BATCH_INPUTS + 3 }, () => 'a');
    expect(planBatches(texts).map((b) => b.length)).toEqual([MAX_BATCH_INPUTS, 3]);
  });

  it('splits on the character limit', () => {
    const big = 'x'.repeat(MAX_BATCH_CHARS / 2 + 1);
    expect(planBatches([big, big, 'y']).map((b) => b.length)).toEqual([1, 2]);
  });
});

describe('writeWindowsFile', () => {
  const segments = [seg(0, 4, 'hello there'), seg(4, 8, 'general kenobi'), seg(8, 14, 'you are a bold one')];
  const dim = 3;

  function fakeOpenAI() {
    const create = vi.fn(async (body: { input: string[] }) => ({
      data: body.input.map((text, index) => ({ index, embedding: [text.length / 100, 0.5, -0.5] })),
    }));
    return { client: { embeddings: { create } } as never, create };
  }

  function fakeS3(headMetadata: Record<string, string> | null) {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        if (headMetadata === null) {
          throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        }
        return { Metadata: headMetadata };
      }
      return {};
    });
    return { client: { send } as never, send };
  }

  async function currentMetadata(): Promise<Record<string, string>> {
    // Write once against an empty bucket to learn the metadata a current file carries.
    const s3 = fakeS3(null);
    await writeWindowsFile({
      s3: s3.client,
      openai: fakeOpenAI().client,
      bucket: 'b',
      audioMediaId: 'm1',
      audioSegments: segments,
      model: 'text-embedding-3-small',
      dimensions: dim,
    });
    const put = s3.send.mock.calls.map((c) => c[0]).find((c) => c instanceof PutObjectCommand) as PutObjectCommand;
    return put.input.Metadata!;
  }

  it('writes the file when none exists', async () => {
    const s3 = fakeS3(null);
    const openai = fakeOpenAI();
    const result = await writeWindowsFile({
      s3: s3.client,
      openai: openai.client,
      bucket: 'b',
      audioMediaId: 'm1',
      audioSegments: segments,
      model: 'text-embedding-3-small',
      dimensions: dim,
      now: () => new Date('2026-09-29T00:00:00Z'),
    });

    expect(result.status).toBe('written');
    expect(result.sentenceCount).toBe(3);
    // Six windows (two lengths x three sentences) in one request.
    expect(openai.create).toHaveBeenCalledTimes(1);
    expect(openai.create.mock.calls[0][0]).toMatchObject({ model: 'text-embedding-3-small', dimensions: dim });

    const put = s3.send.mock.calls.map((c) => c[0]).find((c) => c instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input.Key).toBe(windowsKey('m1'));
    expect(put.input.Key).toBe('processed/m1/windows.bin');
    const decoded = decodeWindowsFile(put.input.Body as Buffer);
    expect(decoded.header).toMatchObject({ embeddingDim: dim, sentenceCount: 3, windowSecs: [10, 30] });
    expect(decoded.table[0]).toEqual({ sentStart: 0, sentEnd: 4, windowEnds: [14, 14] });
    // 10s window at sentence 0 covers all three sentences: 'hello there general kenobi you are a bold one'.
    expect(decoded.vectors[0][0][0]).toBeCloseTo(45 / 100, 3);
  });

  it('skips when the existing file is current', async () => {
    const metadata = await currentMetadata();
    const s3 = fakeS3(metadata);
    const openai = fakeOpenAI();
    const result = await writeWindowsFile({
      s3: s3.client,
      openai: openai.client,
      bucket: 'b',
      audioMediaId: 'm1',
      audioSegments: segments,
      model: 'text-embedding-3-small',
      dimensions: dim,
    });
    expect(result.status).toBe('skipped-current');
    expect(openai.create).not.toHaveBeenCalled();
  });

  it('writes when the existing file was built from a different transcript', async () => {
    const s3 = fakeS3(windowsObjectMetadata('text-embedding-3-small', dim, 'other-sha'));
    const result = await writeWindowsFile({
      s3: s3.client,
      openai: fakeOpenAI().client,
      bucket: 'b',
      audioMediaId: 'm1',
      audioSegments: segments,
      model: 'text-embedding-3-small',
      dimensions: dim,
    });
    expect(result.status).toBe('written');
  });

  it('writes when force is set, without checking the existing file', async () => {
    const metadata = await currentMetadata();
    const s3 = fakeS3(metadata);
    const result = await writeWindowsFile({
      s3: s3.client,
      openai: fakeOpenAI().client,
      bucket: 'b',
      audioMediaId: 'm1',
      audioSegments: segments,
      model: 'text-embedding-3-small',
      dimensions: dim,
      force: true,
    });
    expect(result.status).toBe('written');
    expect(s3.send.mock.calls.some((c) => c[0] instanceof HeadObjectCommand)).toBe(false);
  });

  it('skips an empty transcript', async () => {
    const s3 = fakeS3(null);
    const result = await writeWindowsFile({
      s3: s3.client,
      openai: fakeOpenAI().client,
      bucket: 'b',
      audioMediaId: 'm1',
      audioSegments: [],
    });
    expect(result).toEqual({ status: 'skipped-empty', sentenceCount: 0 });
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('throws on a HeadObject error other than not-found', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    });
    await expect(
      writeWindowsFile({
        s3: { send } as never,
        openai: fakeOpenAI().client,
        bucket: 'b',
        audioMediaId: 'm1',
        audioSegments: segments,
      })
    ).rejects.toThrow('denied');
  });
});
