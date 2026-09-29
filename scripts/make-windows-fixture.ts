/**
 * Write the reference windows.bin fixture that graphiti's reader is tested
 * against (PROD-263, PROD-267).
 *
 * The file holds 12 made-up sentences with 8-dimensional vectors, so a reader
 * can be checked without the embedding API. Vector values are deterministic:
 *
 *   value(window, row, col) = ((row * 31 + col * 7 + window * 13) % 100) / 100 - 0.5
 *
 * where window is 0 for the 10s set and 1 for the 30s set.
 *
 * Usage:
 *   npx tsx scripts/make-windows-fixture.ts --out-dir ../graphiti/tests/fixtures
 *
 * Writes windows_v1.bin and windows_v1.json (the decoded header, table and
 * vectors, which the reader must reproduce).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { TranscriptSegment } from '../packages/functions/src/process-transcript/types';
import { buildSentences } from '../packages/functions/src/process-transcript/windows/sentences';
import { buildWindows } from '../packages/functions/src/process-transcript/windows/build-windows';
import {
  createWindowsFile,
  decodeWindowsFile,
  writeVector,
} from '../packages/functions/src/process-transcript/windows/encode';
import { WINDOW_SECS } from '../packages/functions/src/process-transcript/windows/write-windows';

const SENTENCE_COUNT = 12;
const DIM = 8;

export function fixtureSegments(): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let t = 1.25;
  for (let i = 0; i < SENTENCE_COUNT; i++) {
    const length = 3 + (i % 3) * 1.5;
    segments.push({
      id: String(i),
      start_time: t.toFixed(3),
      end_time: (t + length).toFixed(3),
      transcript: `Sentence number ${i}.`,
      speaker_label: `spk_${i % 2}`,
    });
    t += length + 0.5;
  }
  return segments;
}

export function fixtureValue(window: number, row: number, col: number): number {
  return ((row * 31 + col * 7 + window * 13) % 100) / 100 - 0.5;
}

export function buildFixture(): { bin: Buffer; json: string } {
  const sentences = buildSentences(fixtureSegments());
  const windowSets = WINDOW_SECS.map((sec) => buildWindows(sentences, sec));
  const file = createWindowsFile({
    embeddingModel: 'text-embedding-3-small',
    embeddingDim: DIM,
    windowSecs: WINDOW_SECS,
    transcriptSha256: 'fixture',
    generatedAt: '2026-09-29T00:00:00.000Z',
    table: sentences.map((s, i) => ({
      sentStart: s.start,
      sentEnd: s.end,
      windowEnds: windowSets.map((set) => set[i].end),
    })),
  });

  for (let w = 0; w < WINDOW_SECS.length; w++) {
    for (let row = 0; row < sentences.length; row++) {
      writeVector(
        file,
        row,
        w,
        Array.from({ length: DIM }, (_, col) => fixtureValue(w, row, col))
      );
    }
  }

  const decoded = decodeWindowsFile(file.buffer);
  const json = JSON.stringify(
    {
      description:
        'Expected contents of windows_v1.bin. vectors[w][row] is the float16-decoded vector; w=0 is 10s, w=1 is 30s.',
      header: decoded.header,
      table: decoded.table.map((r) => [r.sentStart, r.sentEnd, ...r.windowEnds]),
      vectors: decoded.vectors,
    },
    null,
    2
  );
  return { bin: file.buffer, json: `${json}\n` };
}

function main(): void {
  const i = process.argv.indexOf('--out-dir');
  const outDir = i >= 0 ? process.argv[i + 1] : undefined;
  if (!outDir) {
    console.error('Usage: npx tsx scripts/make-windows-fixture.ts --out-dir <dir>');
    process.exit(1);
  }
  const { bin, json } = buildFixture();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'windows_v1.bin'), bin);
  writeFileSync(join(outDir, 'windows_v1.json'), json);
  console.log(`Wrote windows_v1.bin (${bin.length} bytes) and windows_v1.json to ${outDir}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
