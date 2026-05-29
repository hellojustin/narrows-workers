/**
 * Backfill HLS subtitle tracks for existing processed audio.
 *
 * Usage:
 *   dotenv -e .env.production -- tsx scripts/backfill-hls-subtitles.ts
 *   dotenv -e .env.production -- tsx scripts/backfill-hls-subtitles.ts --dry-run
 *   dotenv -e .env.production -- tsx scripts/backfill-hls-subtitles.ts --concurrency 20
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { masterManifestKey, transcriptJsonKey } from "../packages/functions/src/generate-hls-subtitles/paths";
import { masterManifestHasSubtitles } from "../packages/functions/src/generate-hls-subtitles/webvtt";

const s3 = new S3Client({});
const sqs = new SQSClient({});

interface CliOptions {
  dryRun: boolean;
  concurrency: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  let dryRun = false;
  let concurrency = 20;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--concurrency" && args[i + 1]) {
      concurrency = parseInt(args[++i], 10);
    }
  }

  return { dryRun, concurrency };
}

async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

async function manifestHasSubtitles(bucket: string, audioMediaId: string): Promise<boolean> {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: masterManifestKey(audioMediaId),
      })
    );
    const body = (await response.Body?.transformToString()) ?? "";
    return masterManifestHasSubtitles(body);
  } catch {
    return false;
  }
}

async function listMediaIds(bucket: string): Promise<string[]> {
  const mediaIds: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "processed/",
        Delimiter: "/",
        ContinuationToken: continuationToken,
      })
    );

    for (const prefix of response.CommonPrefixes ?? []) {
      const match = prefix.Prefix?.match(/^processed\/([^/]+)\/$/);
      if (match?.[1]) {
        mediaIds.push(match[1]);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return mediaIds;
}

async function lookupEpisodeId(
  apiUrl: string,
  apiKey: string,
  audioMediaId: string
): Promise<string | null> {
  const response = await fetch(
    `${apiUrl}/api/v1/episodes?audioMediaId=${encodeURIComponent(audioMediaId)}&limit=1`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  );

  if (!response.ok) {
    console.warn(`Episode lookup failed for ${audioMediaId}: ${response.status}`);
    return null;
  }

  const { data } = (await response.json()) as { data?: Array<{ id: string }> };
  return data?.[0]?.id ?? null;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function main() {
  const { dryRun, concurrency } = parseArgs();

  const bucket = process.env.MEDIA_BUCKET_NAME;
  const queueUrl = process.env.SUBTITLE_GENERATION_QUEUE_URL;
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  if (!bucket || !queueUrl || !apiUrl || !apiKey) {
    throw new Error(
      "MEDIA_BUCKET_NAME, SUBTITLE_GENERATION_QUEUE_URL, NARROWS_API_URL, and NARROWS_API_KEY must be set"
    );
  }

  console.log(`Listing media IDs in s3://${bucket}/processed/ ...`);
  const mediaIds = await listMediaIds(bucket);
  console.log(`Found ${mediaIds.length} media IDs`);

  const stats = {
    checked: 0,
    eligible: 0,
    alreadyDone: 0,
    missingTranscript: 0,
    missingHls: 0,
    noEpisode: 0,
    enqueued: 0,
  };

  const eligible: Array<{ episodeId: string; audioMediaId: string }> = [];

  await mapWithConcurrency(mediaIds, concurrency, async (audioMediaId) => {
    stats.checked++;

    const hasTranscript = await objectExists(bucket, transcriptJsonKey(audioMediaId));
    if (!hasTranscript) {
      stats.missingTranscript++;
      return;
    }

    const hasHls = await objectExists(bucket, masterManifestKey(audioMediaId));
    if (!hasHls) {
      stats.missingHls++;
      return;
    }

    if (await manifestHasSubtitles(bucket, audioMediaId)) {
      stats.alreadyDone++;
      return;
    }

    const episodeId = await lookupEpisodeId(apiUrl, apiKey, audioMediaId);
    if (!episodeId) {
      stats.noEpisode++;
      console.warn(`No episode found for audioMediaId ${audioMediaId}`);
      return;
    }

    stats.eligible++;
    eligible.push({ episodeId, audioMediaId });
  });

  console.log(
    `Checked ${stats.checked}/${mediaIds.length} | Eligible: ${stats.eligible} | Already done: ${stats.alreadyDone} | Missing transcript: ${stats.missingTranscript} | Missing HLS: ${stats.missingHls} | No episode: ${stats.noEpisode}`
  );

  if (dryRun) {
    console.log(`Dry run — would enqueue ${eligible.length} jobs`);
    return;
  }

  for (let i = 0; i < eligible.length; i += 10) {
    const batch = eligible.slice(i, i + 10);
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((item, idx) => ({
          Id: String(idx),
          MessageBody: JSON.stringify(item),
        })),
      })
    );
    stats.enqueued += batch.length;
  }

  console.log(`Enqueued ${stats.enqueued} subtitle generation jobs`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
