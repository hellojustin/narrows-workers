import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { SQSEvent } from "aws-lambda";

const DURATION_SEC = 542;
const FRAMES_PER_SECOND = 20;

const mocks = vi.hoisted(() => ({
  probeAudio: vi.fn(),
  spawnFfmpeg: vi.fn(),
  downloadRawAudio: vi.fn(),
  uploadOne: vi.fn(),
  analyzeS16lePcm: vi.fn(),
}));

vi.mock("@/shared/ffmpeg", () => ({
  probeAudio: mocks.probeAudio,
  spawnFfmpeg: mocks.spawnFfmpeg,
  timeoutFromContext: () => 60_000,
}));

vi.mock("@/shared/s3-media", () => ({
  downloadRawAudio: mocks.downloadRawAudio,
  uploadOne: mocks.uploadOne,
}));

vi.mock("@/shared/waveform", () => ({
  analyzeS16lePcm: mocks.analyzeS16lePcm,
  buildWaveformOverview: (data: unknown) => data,
  encodeWaveformBinary: () => new Uint8Array(1_024),
  encodeWaveformJson: () => "{}",
  // vi.mock factories are hoisted above the file's constants, so this repeats
  // the frames-per-second literal rather than referencing FRAMES_PER_SECOND.
  WAVEFORM_DEFAULTS: {
    sampleRate: 48_000,
    channels: 2,
    framesPerSecond: 20,
    fftSize: 4_096,
    bandCount: 16,
    bandLowHz: 40,
    bandHighHz: 12_000,
    dynamicRangeDb: 96,
  },
}));

import {
  main,
  waveformBinaryKey,
  waveformJsonKey,
  waveformOverviewKey,
} from "@/analyze-audio/handler";

const audioMediaId = "media-123";
const episodeId = "episode-456";
const apiUrl = "https://narrows.example.com";

function sqsEvent(body: unknown): SQSEvent {
  return { Records: [{ body: JSON.stringify(body) }] } as SQSEvent;
}

function waveformCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/waveform"));
}

function invoke(body: unknown) {
  return main(sqsEvent(body), undefined as never, undefined as never);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MEDIA_BUCKET_NAME = "test-bucket";
  process.env.NARROWS_API_URL = apiUrl;
  process.env.NARROWS_API_KEY = "test-key";

  mocks.downloadRawAudio.mockResolvedValue({ bytes: 8_700_000 });
  mocks.uploadOne.mockResolvedValue(undefined);
  mocks.probeAudio.mockResolvedValue({
    durationSec: DURATION_SEC,
    sampleRate: 48_000,
    channels: 2,
    codecName: "mp3",
  });
  mocks.spawnFfmpeg.mockReturnValue({
    stdout: Readable.from([Buffer.alloc(0)]),
    completion: Promise.resolve({ stderr: "", exitCode: 0 }),
  });
  mocks.analyzeS16lePcm.mockResolvedValue({
    frameCount: DURATION_SEC * FRAMES_PER_SECOND,
    framesPerSecond: FRAMES_PER_SECOND,
    channels: 2,
    bandCount: 16,
    peaks: [],
    bands: [],
  });

  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("waveform keys", () => {
  it("are fixed, because the API builds client URLs from the same layout", () => {
    expect(waveformBinaryKey(audioMediaId)).toBe(`processed/${audioMediaId}/waveform.bin`);
    expect(waveformJsonKey(audioMediaId)).toBe(`processed/${audioMediaId}/waveform.json`);
    expect(waveformOverviewKey(audioMediaId)).toBe(
      `processed/${audioMediaId}/waveform-overview.bin`
    );
  });
});

/**
 * The report is what lets the Narrows API tell a client a waveform exists. Without
 * it the episode's waveformStatus stays null and the data is unreachable even
 * though it is in S3.
 */
describe("status reporting", () => {
  it("reports ready after a successful analysis", async () => {
    await invoke({ episodeId, audioMediaId });

    const calls = waveformCalls();
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe(`${apiUrl}/api/v1/internal/episodes/${episodeId}/waveform`);
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toEqual({ status: "ready" });
  });

  it("reports failed and still rethrows, so SQS retries", async () => {
    mocks.probeAudio.mockRejectedValue(new Error("ffprobe exited with code 1"));

    await expect(invoke({ episodeId, audioMediaId })).rejects.toThrow(/ffprobe exited/);

    const calls = waveformCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ status: "failed" });
  });

  it("does not report when the message carries no episodeId", async () => {
    // The measurement harness and the backfill enqueue by media id alone.
    await invoke({ audioMediaId });

    expect(waveformCalls()).toHaveLength(0);
    expect(mocks.uploadOne).toHaveBeenCalled();
  });

  it("does not fail the analysis when reporting throws", async () => {
    // The waveform files are already uploaded by this point. Failing here would
    // send the message back to SQS and redo the whole decode to fix a status field.
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(invoke({ episodeId, audioMediaId })).resolves.toBeUndefined();
  });

  it("does not fail the analysis when reporting returns a non-2xx", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await expect(invoke({ episodeId, audioMediaId })).resolves.toBeUndefined();
  });

  it("does not report when the API is not configured", async () => {
    delete process.env.NARROWS_API_URL;

    await invoke({ episodeId, audioMediaId });

    expect(waveformCalls()).toHaveLength(0);
  });
});

describe("message validation", () => {
  it("drops a message with no audioMediaId rather than retrying it", async () => {
    await expect(invoke({ episodeId })).resolves.toBeUndefined();

    expect(mocks.probeAudio).not.toHaveBeenCalled();
    expect(waveformCalls()).toHaveLength(0);
  });
});

describe("JSON emission", () => {
  it("writes JSON for a short episode and only the binary for a long one", async () => {
    await invoke({ episodeId, audioMediaId });
    const shortKeys = mocks.uploadOne.mock.calls.map(([, item]) => item.key);
    expect(shortKeys).toContain(`processed/${audioMediaId}/waveform.bin`);
    expect(shortKeys).toContain(`processed/${audioMediaId}/waveform.json`);

    // 2h35m. JSON at full episode length reaches tens of megabytes, so above the
    // threshold only the binary form is written, and the API withholds jsonUrl.
    vi.clearAllMocks();
    mocks.uploadOne.mockResolvedValue(undefined);
    mocks.probeAudio.mockResolvedValue({
      durationSec: 9_272,
      sampleRate: 48_000,
      channels: 2,
      codecName: "mp3",
    });
    mocks.spawnFfmpeg.mockReturnValue({
      stdout: Readable.from([Buffer.alloc(0)]),
      completion: Promise.resolve({ stderr: "", exitCode: 0 }),
    });
    mocks.analyzeS16lePcm.mockResolvedValue({
      frameCount: 9_272 * FRAMES_PER_SECOND,
      framesPerSecond: FRAMES_PER_SECOND,
      channels: 2,
      bandCount: 16,
      peaks: [],
      bands: [],
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await invoke({ episodeId, audioMediaId });
    const longKeys = mocks.uploadOne.mock.calls.map(([, item]) => item.key);
    expect(longKeys).toContain(`processed/${audioMediaId}/waveform.bin`);
    expect(longKeys).not.toContain(`processed/${audioMediaId}/waveform.json`);
  });
});

describe("overview emission", () => {
  /**
   * The overview is the object a client fetches to draw the scrubber, so an
   * episode missing one has no waveform as far as the player is concerned.
   * Unlike the JSON form it is written at every duration.
   */
  it("writes an overview whatever the episode length", async () => {
    await invoke({ episodeId, audioMediaId });
    const keys = mocks.uploadOne.mock.calls.map(([, item]) => item.key);

    expect(keys).toContain(`processed/${audioMediaId}/waveform-overview.bin`);
    expect(
      mocks.uploadOne.mock.calls.find(
        ([, item]) => item.key === `processed/${audioMediaId}/waveform-overview.bin`
      )?.[1]
    ).toMatchObject({
      contentType: "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    });
  });
});
