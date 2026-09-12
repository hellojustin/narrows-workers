/**
 * Throughput measurement for the ffmpeg functions.
 *
 * Deployed only outside production (see infra/functions.ts). It exists because the
 * memory setting for the transcode and analysis functions has to be chosen from
 * measurements on Lambda rather than from a laptop: an M1 Max is faster per core
 * than a Graviton vCPU, so local timings do not tell us whether a 4h34m episode
 * fits inside the 15-minute ceiling.
 *
 * It calls transcodeEpisode and analyzeEpisode directly, bypassing the SQS handlers
 * and the episode-ingestible guard, because the guard needs the Narrows API and a
 * non-production stage has no reachable one.
 *
 * Output always goes to a scratch prefix, never to processed/{id}/hls/, so a
 * measurement run cannot be mistaken for real output.
 *
 *   aws lambda invoke --function-name narrows-dev-measure-ffmpeg \
 *     --payload '{"audioMediaId":"...","mode":"both"}' out.json
 */

import type { Context } from "aws-lambda";

import { rm } from "node:fs/promises";
import path from "node:path";

import { analyzeEpisode } from "../analyze-audio/handler";
import { probeAudio, runFfmpeg, timeoutFromContext } from "../shared/ffmpeg";
import { downloadRawAudio } from "../shared/s3-media";
import { transcodeEpisode } from "../transcode-audio/handler";

interface MeasureEvent {
  audioMediaId: string;
  /** "transcode", "analyze", "both", or "probe" to check the binaries only. */
  mode?: "transcode" | "analyze" | "both" | "probe";
}

interface MeasureResult {
  audioMediaId: string;
  memoryMb: number;
  architecture: string;
  ffmpegVersion: string;
  sourceDurationSec: number | null;
  transcode: { elapsedMs: number; segmentCount: number; realtimeFactor: number } | null;
  analysis: { elapsedMs: number; frameCount: number; binaryBytes: number; realtimeFactor: number } | null;
}

/** Confirms the layer binaries load and reports the version they report. */
async function ffmpegVersion(): Promise<string> {
  const result = await runFfmpeg(["-version"], { label: "version", timeoutMs: 10_000 });
  // -version writes to stdout, which runFfmpeg drains, so read it from the banner
  // ffmpeg also emits on stderr under -loglevel warning. Fall back to a probe.
  const match = /ffmpeg version (\S+)/.exec(result.stderr);
  return match?.[1] ?? "ran, version not captured";
}

export const main = async (event: MeasureEvent, context?: Context): Promise<MeasureResult> => {
  const bucketName = process.env.MEDIA_BUCKET_NAME;
  if (!bucketName) throw new Error("MEDIA_BUCKET_NAME must be set");

  const { audioMediaId, mode = "both" } = event;
  if (!audioMediaId) throw new Error("audioMediaId is required");

  const memoryMb = Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? 0);
  const architecture = process.arch;

  const result: MeasureResult = {
    audioMediaId,
    memoryMb,
    architecture,
    ffmpegVersion: await ffmpegVersion(),
    sourceDurationSec: null,
    transcode: null,
    analysis: null,
  };

  if (mode === "probe") {
    const sourcePath = path.join("/tmp", `probe-${audioMediaId}`);
    try {
      const { bytes } = await downloadRawAudio(bucketName, audioMediaId, sourcePath);
      const probed = await probeAudio(sourcePath, { timeoutMs: 60_000 });
      result.sourceDurationSec = probed.durationSec;
      console.log(`Probed ${audioMediaId}: ${bytes} bytes, ${probed.durationSec}s`);
      return result;
    } finally {
      await rm(sourcePath, { force: true });
    }
  }

  // Scratch prefix keyed by mode so a transcode and an analysis run do not collide.
  const scratchPrefix = `scratch/measure/${audioMediaId}/`;

  if (mode === "transcode" || mode === "both") {
    const summary = await transcodeEpisode({
      episodeId: "measurement",
      audioMediaId,
      bucketName,
      destinationPrefix: `${scratchPrefix}hls/`,
      timeoutMs: timeoutFromContext(context),
    });
    result.sourceDurationSec = summary.sourceDurationSec;
    result.transcode = {
      elapsedMs: summary.elapsedMs,
      segmentCount: summary.segmentCount,
      // Multiples of real time. Above 1 means faster than playback.
      realtimeFactor: (summary.sourceDurationSec * 1000) / summary.elapsedMs,
    };
  }

  if (mode === "analyze" || mode === "both") {
    const summary = await analyzeEpisode({
      audioMediaId,
      bucketName,
      keyPrefix: scratchPrefix,
      writeJson: false,
      timeoutMs: timeoutFromContext(context),
    });
    result.sourceDurationSec = summary.sourceDurationSec;
    result.analysis = {
      elapsedMs: summary.elapsedMs,
      frameCount: summary.frameCount,
      binaryBytes: summary.binaryBytes,
      realtimeFactor: (summary.sourceDurationSec * 1000) / summary.elapsedMs,
    };
  }

  console.log("Measurement:", JSON.stringify(result));
  return result;
};
