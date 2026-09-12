import type { Context, SQSEvent, SQSHandler } from "aws-lambda";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { isEpisodeIngestible } from "../shared/episode-guard";
import { probeAudio, timeoutFromContext } from "../shared/ffmpeg";
import { downloadRawAudio, uploadAll, uploadOne } from "../shared/s3-media";
import { hlsPrefix } from "../generate-hls-subtitles/paths";
import { tryEnqueueAfterTranscode } from "../generate-hls-subtitles/enqueue";
import { transcodeToHls, verifyPlaylistAgainstSegments, SEGMENT_SECONDS } from "./hls";

interface TranscodeMessage {
  episodeId: string;
  audioMediaId: string;
  /**
   * Set by a shadow run to write somewhere other than the real HLS prefix. When
   * present the fan-in is skipped, so the output stays invisible to the pipeline.
   */
  destinationPrefix?: string;
}

/**
 * Lambda gives every invocation a writable /tmp. Ephemeral storage is configured
 * to 4096 MB, which covers the largest episode in the catalogue: 4h34m is about
 * 400 MB of source and 264 MB of segments.
 */
function scratchDir(audioMediaId: string): string {
  return path.join("/tmp", `hls-${audioMediaId}`);
}

/**
 * Kept outside scratchDir, because transcodeToHls clears its output directory
 * before running and would otherwise delete the source it is about to read.
 */
function sourcePathFor(audioMediaId: string): string {
  return path.join("/tmp", `src-${audioMediaId}`);
}

async function updateEpisode(
  episodeId: string,
  updates: { processingStatus?: string; processingError?: string }
): Promise<void> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;
  if (!apiUrl || !apiKey) return;

  await fetch(`${apiUrl}/api/v1/episodes/${episodeId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updates),
  });
}

export interface TranscodeSummary {
  audioMediaId: string;
  sourceDurationSec: number;
  segmentCount: number;
  playlistDurationSec: number;
  elapsedMs: number;
}

/**
 * Transcode one episode and upload the result.
 *
 * Exported separately from the handler so the verification harness and the
 * throughput measurement can drive it without constructing an SQS event.
 */
export async function transcodeEpisode(params: {
  episodeId: string;
  audioMediaId: string;
  bucketName: string;
  /** Overrides the destination prefix. Used by the shadow run to write to scratch. */
  destinationPrefix?: string;
  subtitleQueueUrl?: string;
  timeoutMs?: number;
}): Promise<TranscodeSummary> {
  const { episodeId, audioMediaId, bucketName } = params;
  const startedAt = Date.now();
  const outputDir = scratchDir(audioMediaId);
  const sourcePath = sourcePathFor(audioMediaId);
  const destinationPrefix = params.destinationPrefix ?? hlsPrefix(audioMediaId);

  try {
    const { bytes } = await downloadRawAudio(bucketName, audioMediaId, sourcePath);
    console.log(`Downloaded ${bytes} bytes for ${audioMediaId}`);

    const probed = await probeAudio(sourcePath, { timeoutMs: 60_000 });
    console.log(
      `Source for ${audioMediaId}: ${probed.durationSec.toFixed(3)}s ${probed.codecName} ` +
        `${probed.sampleRate}Hz ${probed.channels}ch`
    );

    const output = await transcodeToHls({
      input: sourcePath,
      outputDir,
      audioMediaId,
      ffmpegOptions: {
        timeoutMs: params.timeoutMs,
        onProgress: (sec) => {
          const pct = probed.durationSec > 0 ? (sec / probed.durationSec) * 100 : 0;
          console.log(`Transcode ${audioMediaId}: ${sec.toFixed(0)}s (${pct.toFixed(0)}%)`);
        },
      },
    });

    const audioPlaylist = await readFile(
      path.join(outputDir, output.audioPlaylistName),
      "utf8"
    );
    const check = verifyPlaylistAgainstSegments(audioPlaylist, output.segmentNames);

    // The transcode is only correct if it covers the whole source. A truncated
    // run still produces a valid playlist, so compare against the probed duration.
    const durationDelta = Math.abs(check.totalDurationSec - probed.durationSec);
    if (durationDelta > SEGMENT_SECONDS) {
      throw new Error(
        `Transcode of ${audioMediaId} covers ${check.totalDurationSec.toFixed(3)}s but the ` +
          `source is ${probed.durationSec.toFixed(3)}s (delta ${durationDelta.toFixed(3)}s)`
      );
    }

    /**
     * Write ordering matters. The fan-in HeadObjects the master playlist as its
     * signal that HLS is ready, so it goes last: segments, then the media
     * playlist, then the master. Uploading the master earlier would let subtitle
     * generation start against an incomplete stream.
     */
    await uploadAll(
      bucketName,
      output.segmentNames.map((name) => ({
        key: `${destinationPrefix}${name}`,
        filePath: path.join(outputDir, name),
      }))
    );

    await uploadOne(bucketName, {
      key: `${destinationPrefix}${output.audioPlaylistName}`,
      body: audioPlaylist,
    });

    await uploadOne(bucketName, {
      key: `${destinationPrefix}${output.masterPlaylistName}`,
      body: await readFile(path.join(outputDir, output.masterPlaylistName), "utf8"),
    });

    const elapsedMs = Date.now() - startedAt;
    console.log(
      `Transcoded ${audioMediaId}: ${check.segmentCount} segments, ` +
        `${check.totalDurationSec.toFixed(3)}s, ${elapsedMs} ms`
    );

    // Only fan in for real output. A shadow run must stay invisible to the pipeline.
    if (!params.destinationPrefix && params.subtitleQueueUrl) {
      await tryEnqueueAfterTranscode({
        episodeId,
        audioMediaId,
        bucketName,
        queueUrl: params.subtitleQueueUrl,
      });
    }

    return {
      audioMediaId,
      sourceDurationSec: probed.durationSec,
      segmentCount: check.segmentCount,
      playlistDurationSec: check.totalDurationSec,
      elapsedMs,
    };
  } finally {
    // /tmp persists across invocations on a warm container, so a 400 MB source and
    // 264 MB of segments left behind would exhaust ephemeral storage within a few
    // episodes.
    await rm(outputDir, { recursive: true, force: true });
    await rm(sourcePath, { force: true });
  }
}

/**
 * Transcode Audio Lambda
 *
 * Consumes from audio-transcode-queue.
 * Transcodes raw/{audioMediaId} to HLS under processed/{audioMediaId}/hls/.
 * Enqueues subtitle generation when transcript.json is already present.
 */
export const main: SQSHandler = async (event: SQSEvent, context?: Context) => {
  const bucketName = process.env.MEDIA_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("MEDIA_BUCKET_NAME must be set");
  }

  const subtitleQueueUrl = process.env.SUBTITLE_GENERATION_QUEUE_URL;
  if (!subtitleQueueUrl) {
    throw new Error("SUBTITLE_GENERATION_QUEUE_URL must be set");
  }

  for (const record of event.Records) {
    const message: TranscodeMessage = JSON.parse(record.body);
    const { episodeId, audioMediaId, destinationPrefix } = message;
    console.log(
      `Transcoding episode ${episodeId}, media ${audioMediaId}` +
        (destinationPrefix ? ` (shadow: ${destinationPrefix})` : "")
    );

    try {
      if (!(await isEpisodeIngestible(episodeId))) {
        console.log(`Skipping transcode for episode ${episodeId}: not found or series opted out`);
        continue;
      }

      await transcodeEpisode({
        episodeId,
        audioMediaId,
        bucketName,
        destinationPrefix,
        subtitleQueueUrl,
        timeoutMs: timeoutFromContext(context),
      });
    } catch (error) {
      console.error(`Error transcoding episode ${episodeId}:`, error);
      // A shadow run must not touch episode status: the episode's real output
      // came from MediaConvert and is fine.
      if (!destinationPrefix) {
        await updateEpisode(episodeId, {
          processingStatus: "failed",
          processingError: error instanceof Error ? error.message : "Unknown error",
        });
      }
      // Rethrow so SQS retries and, after 3 attempts, moves the message to the DLQ.
      throw error;
    }
  }
};
