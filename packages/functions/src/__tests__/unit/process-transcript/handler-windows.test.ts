import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent, Context } from 'aws-lambda';

const mocks = vi.hoisted(() => ({
  writeWindowsFile: vi.fn(),
  ingestSegmentsToGraphiti: vi.fn(),
  updateEpisodeComplete: vi.fn(),
  updateEpisodeError: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = vi.fn(async () => ({
      Body: {
        transformToString: async () =>
          JSON.stringify({
            results: {
              audio_segments: [
                { id: '0', start_time: '0.0', end_time: '4.0', transcript: 'hello', speaker_label: 'spk_0' },
              ],
              items: [],
            },
          }),
      },
    }));
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('openai', () => ({ default: class {} }));

vi.mock('@/process-transcript/api-client', () => ({
  fetchEpisode: vi.fn(async () => ({
    id: 'ep1',
    seriesId: 's1',
    title: 'Episode',
    description: '',
    audioMediaId: 'media1',
    publishedAt: null,
    duration: null,
  })),
  fetchSeries: vi.fn(async () => ({ id: 's1', title: 'Series', description: '' })),
  updateEpisodeSpeakers: vi.fn(async () => undefined),
  replaceEpisodeAnalysis: vi.fn(async () => ({
    chaptersCreated: 0,
    segmentsCreated: 0,
    chaptersRemoved: 0,
    segmentsRemoved: 0,
  })),
  updateEpisodeComplete: mocks.updateEpisodeComplete,
  updateEpisodeError: mocks.updateEpisodeError,
}));

vi.mock('@/process-transcript/identify-speakers', () => ({ identifySpeakers: vi.fn(async () => ({})) }));
vi.mock('@/process-transcript/identify-chapters', () => ({ identifyChapters: vi.fn(async () => []) }));
vi.mock('@/process-transcript/identify-segments', () => ({ identifySegments: vi.fn(async () => []) }));
vi.mock('@/process-transcript/ingest-to-graphiti', () => ({
  ingestSegmentsToGraphiti: mocks.ingestSegmentsToGraphiti,
}));
vi.mock('@/process-transcript/windows/write-windows', () => ({ writeWindowsFile: mocks.writeWindowsFile }));

import { main } from '@/process-transcript/handler';

const event = { Records: [{ body: JSON.stringify({ episodeId: 'ep1' }) }] } as unknown as SQSEvent;

describe('process-transcript handler: windows.bin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEDIA_BUCKET_NAME = 'bucket';
    mocks.ingestSegmentsToGraphiti.mockResolvedValue(['g1']);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('writes windows.bin before ingesting to graphiti', async () => {
    const order: string[] = [];
    mocks.writeWindowsFile.mockImplementation(async () => {
      order.push('windows');
      return { status: 'written', sentenceCount: 1 };
    });
    mocks.ingestSegmentsToGraphiti.mockImplementation(async () => {
      order.push('ingest');
      return ['g1'];
    });

    await main(event, {} as Context, () => undefined);

    expect(order).toEqual(['windows', 'ingest']);
    expect(mocks.writeWindowsFile).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'bucket', audioMediaId: 'media1' })
    );
  });

  it('continues ingest when writing windows.bin fails', async () => {
    mocks.writeWindowsFile.mockRejectedValue(new Error('embedding API down'));

    await main(event, {} as Context, () => undefined);

    expect(mocks.ingestSegmentsToGraphiti).toHaveBeenCalledTimes(1);
    expect(mocks.updateEpisodeComplete).toHaveBeenCalledTimes(1);
    expect(mocks.updateEpisodeError).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('WINDOWS_WRITE_FAILED episode=ep1', expect.any(Error));
  });
});
