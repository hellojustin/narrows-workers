import type { Context, SQSEvent, SQSHandler } from "aws-lambda";

import { probeAudio, spawnFfmpeg, timeoutFromContext } from "../shared/ffmpeg";
import { presignedInputUrl, uploadOne } from "../shared/s3-media";
import {
  analyzeS16lePcm,
  encodeWaveformBinary,
  encodeWaveformJson,
  WAVEFORM_DEFAULTS,
  type WaveformData,
} from "../shared/waveform";

interface AnalysisMessage {
  episodeId?: string;
  audioMediaId: string;
  /** Write JSON alongside the binary. Defaults to on for short episodes. */
  writeJson?: boolean;
}

/**
 * JSON is roughly 12x the size of the binary form, so it is written only for
 * short episodes where it stays small enough to be useful for debugging.
 * See docs/waveform-format.md.
 */
const JSON_MAX_DURATION_SEC = 20 * 60;

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export function waveformBinaryKey(audioMediaId: string): string {
  return `processed/${audioMediaId}/waveform.bin`;
}

export function waveformJsonKey(audioMediaId: string): string {
  return `processed/${audioMediaId}/waveform.json`;
}

/**
 * Decode arguments for the analysis.
 *
 * The analyser expects interleaved signed 16-bit little-endian PCM at a known
 * rate and channel count, so the decode is normalised to 48 kHz stereo
 * regardless of the source. Sources vary: 44.1 kHz is common and mono happens.
 */
export function buildDecodeArgs(input: string): string[] {
  return [
    "-i",
    input,
    // First audio stream only. Embedded cover art appears as a video stream.
    "-map",
    "0:a:0",
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "-ar",
    String(WAVEFORM_DEFAULTS.sampleRate),
    "-ac",
    String(WAVEFORM_DEFAULTS.channels),
    "pipe:1",
  ];
}

export interface AnalysisSummary {
  audioMediaId: string;
  sourceDurationSec: number;
  frameCount: number;
  binaryBytes: number;
  jsonBytes: number | null;
  elapsedMs: number;
}

/**
 * Analyse one episode's audio and write the result.
 *
 * Exported separately from the handler so the backfill driver and the throughput
 * measurement can drive it without constructing an SQS event.
 */
export async function analyzeEpisode(params: {
  audioMediaId: string;
  bucketName: string;
  /** Overrides the destination prefix, for scratch runs. */
  keyPrefix?: string;
  writeJson?: boolean;
  timeoutMs?: number;
}): Promise<AnalysisSummary> {
  const { audioMediaId, bucketName } = params;
  const startedAt = Date.now();

  const inputUrl = await presignedInputUrl(bucketName, audioMediaId);
  const probed = await probeAudio(inputUrl, { timeoutMs: 60_000 });
  console.log(
    `Analysing ${audioMediaId}: ${probed.durationSec.toFixed(3)}s ${probed.codecName} ` +
      `${probed.sampleRate}Hz ${probed.channels}ch`
  );

  const proc = spawnFfmpeg(buildDecodeArgs(inputUrl), {
    label: `analyse ${audioMediaId}`,
    timeoutMs: params.timeoutMs,
  });

  let data: WaveformData;
  try {
    // Consuming stdout as an async iterable applies backpressure, so decoded PCM
    // is never buffered. A 4h34m episode decodes to about 3.2 GB.
    data = await analyzeS16lePcm(proc.stdout, {
      sampleRate: WAVEFORM_DEFAULTS.sampleRate,
      channels: WAVEFORM_DEFAULTS.channels,
    });
  } catch (error) {
    proc.kill();
    throw error;
  }

  // Await the exit after draining, so a non-zero exit is not masked by a
  // successful-looking analysis of a truncated stream.
  await proc.completion;

  const expectedFrames = Math.floor(probed.durationSec * data.framesPerSecond);
  if (Math.abs(data.frameCount - expectedFrames) > data.framesPerSecond) {
    throw new Error(
      `Analysis of ${audioMediaId} produced ${data.frameCount} frames but the source ` +
        `duration ${probed.durationSec.toFixed(3)}s implies about ${expectedFrames}`
    );
  }

  const prefix = params.keyPrefix ?? `processed/${audioMediaId}/`;
  const binary = encodeWaveformBinary(data);
  await uploadOne(bucketName, {
    key: `${prefix}waveform.bin`,
    body: binary,
    contentType: "application/octet-stream",
    cacheControl: IMMUTABLE_CACHE,
  });

  const shouldWriteJson = params.writeJson ?? probed.durationSec <= JSON_MAX_DURATION_SEC;
  let jsonBytes: number | null = null;
  if (shouldWriteJson) {
    const json = encodeWaveformJson(data);
    jsonBytes = Buffer.byteLength(json);
    await uploadOne(bucketName, {
      key: `${prefix}waveform.json`,
      body: json,
      contentType: "application/json",
      cacheControl: IMMUTABLE_CACHE,
    });
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `Analysed ${audioMediaId}: ${data.frameCount} frames, ${binary.byteLength} bytes binary` +
      `${jsonBytes === null ? "" : `, ${jsonBytes} bytes JSON`}, ${elapsedMs} ms`
  );

  return {
    audioMediaId,
    sourceDurationSec: probed.durationSec,
    frameCount: data.frameCount,
    binaryBytes: binary.byteLength,
    jsonBytes,
    elapsedMs,
  };
}

/**
 * Analyze Audio Lambda
 *
 * Consumes from audio-analysis-queue.
 * Reads raw/{audioMediaId} and writes waveform data under processed/{audioMediaId}/.
 *
 * Deliberately writes nothing under processed/{audioMediaId}/hls/, so a bug here
 * cannot damage playable output. That separation is also what lets the existing
 * catalogue be backfilled without re-transcoding.
 */
export const main: SQSHandler = async (event: SQSEvent, context?: Context) => {
  const bucketName = process.env.MEDIA_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("MEDIA_BUCKET_NAME must be set");
  }

  for (const record of event.Records) {
    const message: AnalysisMessage = JSON.parse(record.body);
    const { audioMediaId, writeJson } = message;

    if (!audioMediaId) {
      // Nothing to work with, and retrying will not help.
      console.error("Analysis message has no audioMediaId, dropping:", record.body);
      continue;
    }

    try {
      await analyzeEpisode({
        audioMediaId,
        bucketName,
        writeJson,
        timeoutMs: timeoutFromContext(context),
      });
    } catch (error) {
      console.error(`Error analysing media ${audioMediaId}:`, error);
      // Rethrow so SQS retries and, after 3 attempts, moves the message to the
      // DLQ. Episode status is deliberately not touched: waveform data is
      // additive, and a failure here must not mark a playable episode failed.
      throw error;
    }
  }
};
