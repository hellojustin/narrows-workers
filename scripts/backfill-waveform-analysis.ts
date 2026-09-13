/**
 * Backfill waveform analysis for the existing catalogue (PROD-169).
 *
 * Selects episodes that have an audioMediaId and no waveform yet, then enqueues
 * one analysis message per episode, keeping the queue shallow so live ingestion
 * is not delayed behind the backfill.
 *
 * Usage:
 *   AWS_PROFILE=pond npm run backfill:waveform -- --dry-run
 *   AWS_PROFILE=pond npm run backfill:waveform -- --limit 20
 *   AWS_PROFILE=pond npm run backfill:waveform -- --queue-depth-ceiling 50 --batch-size 25
 *   AWS_PROFILE=pond npm run backfill:waveform -- --series <seriesId>
 *
 * Requires MEDIA_BUCKET_NAME, AUDIO_ANALYSIS_QUEUE_URL and DATABASE_URL.
 * DATABASE_URL is read-only here; see runQuery.
 */

import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GetQueueAttributesCommand,
  SendMessageBatchCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { rawKey } from "../packages/functions/src/shared/s3-media";

const execFileAsync = promisify(execFile);

/**
 * This script must only ever send to the audio-analysis queue.
 *
 * analyze-audio has no fan-in. It reads raw/{audioMediaId}, writes
 * processed/{audioMediaId}/waveform.bin and waveform.json, and reports
 * waveformStatus to narrows. It writes nothing under processed/{id}/hls/ and
 * cannot start transcript ingestion.
 *
 * The transcode queue is the opposite: transcode-audio fans in to subtitle
 * generation, which enqueues transcript ingest, which duplicates an episode's
 * segments and chapters. That defect is PROD-218 and has already affected 2,969
 * episodes. One transcode message from this script would corrupt data for every
 * episode it covered, so do not add one, and do not "also re-transcode while
 * we're here". Backfilling waveforms requires no transcode.
 *
 * assertAnalysisQueue enforces this at runtime: a mistyped or wrong
 * AUDIO_ANALYSIS_QUEUE_URL fails the run instead of sending 17,141 messages to
 * the transcoder.
 */
const ANALYSIS_QUEUE_SUFFIX = "-audio-analysis";

/** SendMessageBatch accepts at most 10 entries per request. */
const SQS_BATCH_MAX = 10;

/** arm64 Lambda, us-east-1, per GB-second. */
const ARM64_GB_SECOND_USD = 0.0000133334;
const LAMBDA_REQUEST_USD = 0.0000002;

/** Matches narrows-production-analyze-audio. */
const LAMBDA_MEMORY_MB = 1769;
const RESERVED_CONCURRENCY = 3;

/**
 * Analysis throughput: seconds of audio per second of billed Lambda time.
 *
 * Measured on 40 production episodes through the deployed Lambda: 1,688 s of
 * audio in 54.1 s billed (31x, short episodes where the per-invocation overhead
 * dominates) and 25,817 s of audio in 723.9 s billed (36x, episodes averaging 22
 * minutes, which is the catalogue average). A least-squares fit over both gives
 * 37x marginal plus about 1.4 s fixed per invocation.
 *
 * PROD-169 assumed 78x, which is about twice what the deployed code achieves, so
 * the ticket's ~$3.71 and the 27-hour wall time are both low.
 */
const ANALYSIS_REALTIME_FACTOR = 36;

/**
 * How long to wait before re-reading queue depth.
 *
 * Also applied after every enqueue, because ApproximateNumberOfMessages and
 * ApproximateNumberOfMessagesNotVisible lag the true depth by several seconds.
 * Without the wait the loop reads a stale zero and enqueues another batch
 * immediately, which was measured sending all 20 messages of a test run in about
 * two seconds against a ceiling of 5. Waiting costs nothing: 10 messages per 10
 * seconds is far faster than the queue drains at reserved concurrency 3.
 */
const DEPTH_POLL_INTERVAL_MS = 10_000;

const PROGRESS_INTERVAL_MS = 30_000;

/** psql unaligned output separator. Tabs cannot appear in a UUID or an integer. */
const COLUMN_SEPARATOR = "\t";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CliOptions {
  dryRun: boolean;
  limit?: number;
  seriesId?: string;
  queueDepthCeiling: number;
  batchSize: number;
  /** Parallel HeadObject checks for the raw audio. */
  concurrency: number;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    queueDepthCeiling: 50,
    // One SendMessageBatch call. Larger batches raise how far depth can overshoot
    // the ceiling between depth readings without making the run any faster.
    batchSize: SQS_BATCH_MAX,
    concurrency: 20,
  };

  const positiveInt = (flag: string, raw: string | undefined): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${flag} requires a positive integer, got ${raw ?? "nothing"}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--limit") {
      options.limit = positiveInt(arg, argv[++i]);
    } else if (arg === "--queue-depth-ceiling") {
      options.queueDepthCeiling = positiveInt(arg, argv[++i]);
    } else if (arg === "--batch-size") {
      options.batchSize = positiveInt(arg, argv[++i]);
    } else if (arg === "--concurrency") {
      options.concurrency = positiveInt(arg, argv[++i]);
    } else if (arg === "--series") {
      const value = argv[++i];
      if (!value || !UUID_PATTERN.test(value)) {
        throw new Error(`--series requires a series UUID, got ${value ?? "nothing"}`);
      }
      options.seriesId = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

/**
 * Rejects any queue that is not an audio-analysis queue. See the comment on
 * ANALYSIS_QUEUE_SUFFIX for why this is checked rather than trusted.
 */
export function assertAnalysisQueue(queueUrl: string): void {
  const queueName = queueUrl.split("/").pop() ?? "";
  if (!queueName.endsWith(ANALYSIS_QUEUE_SUFFIX)) {
    throw new Error(
      `AUDIO_ANALYSIS_QUEUE_URL must name a queue ending in ${ANALYSIS_QUEUE_SUFFIX}, got ${queueName}. ` +
        "This script only ever enqueues waveform analysis."
    );
  }
}

export interface Candidate {
  episodeId: string;
  audioMediaId: string;
  durationSec: number;
}

/**
 * The message analyze-audio expects.
 *
 * writeJson is deliberately absent: the handler defaults it on at or under 20
 * minutes and off above, which is the behaviour wanted here. episodeId is
 * required, because it is what lets the handler report waveformStatus back, and
 * waveformStatus is what makes this script resumable.
 */
export function analysisMessageBody(candidate: Candidate): string {
  return JSON.stringify({
    episodeId: candidate.episodeId,
    audioMediaId: candidate.audioMediaId,
  });
}

/**
 * Pending episodes, largest series first.
 *
 * waveform_status is the resumability signal. It is null until the analysis
 * Lambda reports back, so an episode drops out of this query as soon as its
 * waveform lands and a re-run enqueues nothing for it. There is deliberately no
 * checkpoint file: a second record of progress could disagree with the database.
 */
/**
 * psql -c takes no bind parameters, so seriesId is interpolated. parseArgs rejects
 * anything that is not a UUID before it reaches here.
 */
function pendingPredicate(alias: string, seriesId?: string): string {
  const prefix = alias === "" ? "" : `${alias}.`;
  const conditions = [
    `${prefix}deleted_at IS NULL`,
    `${prefix}audio_media_id IS NOT NULL`,
    `${prefix}waveform_status IS NULL`,
  ];
  if (seriesId) {
    conditions.push(`${prefix}series_id = '${seriesId}'`);
  }
  return conditions.join(" AND ");
}

export function selectionSql(options: { seriesId?: string; limit?: number }): string {
  return `
    SELECT e.id, e.audio_media_id, coalesce(e.duration, 0)
    FROM episodes e
    JOIN (
      SELECT series_id, count(*) AS pending
      FROM episodes
      WHERE ${pendingPredicate("", options.seriesId)}
      GROUP BY series_id
    ) s ON s.series_id = e.series_id
    WHERE ${pendingPredicate("e", options.seriesId)}
    ORDER BY s.pending DESC, e.series_id, e.published_at DESC NULLS LAST
    ${options.limit === undefined ? "" : `LIMIT ${options.limit}`}
  `;
}

export function statusCountSql(seriesId?: string): string {
  return `
    SELECT
      count(*) FILTER (WHERE waveform_status = 'ready'),
      count(*) FILTER (WHERE waveform_status = 'failed')
    FROM episodes
    WHERE deleted_at IS NULL
      AND audio_media_id IS NOT NULL
      ${seriesId ? `AND series_id = '${seriesId}'` : ""}
  `;
}

export function parseRows(stdout: string): string[][] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(COLUMN_SEPARATOR));
}

export function toCandidates(rows: string[][]): Candidate[] {
  return rows.map(([episodeId, audioMediaId, duration]) => ({
    episodeId,
    audioMediaId,
    durationSec: Number(duration),
  }));
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export interface CostEstimate {
  audioHours: number;
  computeHours: number;
  gbSeconds: number;
  computeUsd: number;
  requestUsd: number;
  totalUsd: number;
  wallHours: number;
}

export function estimateCost(episodeCount: number, totalDurationSec: number): CostEstimate {
  const computeSec = totalDurationSec / ANALYSIS_REALTIME_FACTOR;
  const gbSeconds = computeSec * (LAMBDA_MEMORY_MB / 1024);
  const computeUsd = gbSeconds * ARM64_GB_SECOND_USD;
  const requestUsd = episodeCount * LAMBDA_REQUEST_USD;

  return {
    audioHours: totalDurationSec / 3600,
    computeHours: computeSec / 3600,
    gbSeconds,
    computeUsd,
    requestUsd,
    totalUsd: computeUsd + requestUsd,
    wallHours: computeSec / 3600 / RESERVED_CONCURRENCY,
  };
}

/**
 * Read-only query against the narrows database.
 *
 * default_transaction_read_only is set for the psql session, so the server
 * rejects any statement that would write. The only writes this script makes are
 * SQS messages.
 *
 * The selection needs `waveform_status IS NULL`, which the narrows episodes API
 * cannot express, so this reads the database directly rather than paging the API
 * as the subtitles backfill does.
 */
async function runQuery(databaseUrl: string, sql: string): Promise<string[][]> {
  const { stdout } = await execFileAsync(
    "psql",
    [databaseUrl, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-At", "-F", COLUMN_SEPARATOR, "-c", sql],
    {
      env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on" },
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  return parseRows(stdout);
}

async function readStatusCounts(
  databaseUrl: string,
  seriesId?: string
): Promise<{ ready: number; failed: number }> {
  const rows = await runQuery(databaseUrl, statusCountSql(seriesId));
  const [ready, failed] = rows[0] ?? ["0", "0"];
  return { ready: Number(ready), failed: Number(failed) };
}

/**
 * A missing object is skipped and reported; anything else, such as a permissions
 * or throttling error, must fail the run rather than be counted as missing audio.
 */
export function isMissingObjectError(error: unknown): boolean {
  const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404;
}

async function rawObjectExists(
  s3: S3Client,
  bucket: string,
  audioMediaId: string
): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: rawKey(audioMediaId) }));
    return true;
  } catch (error) {
    if (isMissingObjectError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Queue depth including in-flight messages, which is what bounds how long a live
 * episode waits behind the backfill.
 */
async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    })
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hours(seconds: number): string {
  return (seconds / 3600).toFixed(1);
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);

  const bucket = requireEnv("MEDIA_BUCKET_NAME");
  const queueUrl = requireEnv("AUDIO_ANALYSIS_QUEUE_URL");
  const databaseUrl = requireEnv("DATABASE_URL");

  assertAnalysisQueue(queueUrl);

  const startedAt = Date.now();
  const candidates = toCandidates(await runQuery(databaseUrl, selectionSql(options)));
  const totalDurationSec = candidates.reduce((sum, c) => sum + c.durationSec, 0);
  const unknownDuration = candidates.filter((c) => c.durationSec === 0).length;
  const estimate = estimateCost(candidates.length, totalDurationSec);

  console.log(`Episodes needing waveform: ${candidates.length}`);
  console.log(`Audio to process: ${estimate.audioHours.toFixed(1)} hours`);
  if (unknownDuration > 0) {
    console.log(
      `${unknownDuration} of those have no recorded duration and count as zero in the estimate`
    );
  }
  console.log(
    `Projected Lambda cost: ${usd(estimate.totalUsd)} ` +
      `(${estimate.gbSeconds.toFixed(0)} GB-s at ${LAMBDA_MEMORY_MB} MB arm64, ` +
      `${estimate.computeHours.toFixed(1)} compute hours at ${ANALYSIS_REALTIME_FACTOR}x realtime, ` +
      `plus ${usd(estimate.requestUsd)} of requests)`
  );
  console.log(
    `Projected wall time: ${estimate.wallHours.toFixed(1)} hours at reserved concurrency ${RESERVED_CONCURRENCY}`
  );

  if (options.dryRun) {
    console.log("Dry run — nothing enqueued, and no raw objects checked");
    return;
  }

  const s3 = new S3Client({});
  const sqs = new SQSClient({});

  /**
   * Baseline for the completed and failed columns below. Live ingestion, about 70
   * episodes a day, also moves these counts, so treat the columns as approximate
   * and the database as authoritative:
   *
   *   SELECT waveform_status, count(*) FROM episodes
   *   WHERE deleted_at IS NULL AND audio_media_id IS NOT NULL GROUP BY 1;
   */
  const baseline = await readStatusCounts(databaseUrl, options.seriesId);

  const stats = { enqueued: 0, missingRaw: 0 };
  const missingRawIds: string[] = [];
  let lastProgressAt = 0;
  let lastDepth = 0;

  async function printProgress(force = false): Promise<void> {
    if (!force && Date.now() - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = Date.now();
    const counts = await readStatusCounts(databaseUrl, options.seriesId);
    console.log(
      `[${new Date().toISOString()}] enqueued ${stats.enqueued}/${candidates.length} | ` +
        `completed ${counts.ready - baseline.ready} | failed ${counts.failed - baseline.failed} | ` +
        `missing raw ${stats.missingRaw} | queue depth ${lastDepth}`
    );
  }

  /**
   * Enqueue only while the queue is shallow.
   *
   * narrows-production-analyze-audio has reserved concurrency 3, shared with live
   * ingestion. SQS delivers roughly in order, so enqueueing the whole catalogue
   * up front would put a live episode's analysis behind every backfill message
   * and delay its waveform by the length of the run, which is over a day.
   *
   * At a ceiling of 50, with analysis averaging about 37 seconds of Lambda time
   * per episode over three workers, a live episode waits about ten minutes at
   * worst, and stopping the script drains the queue in about the same time.
   * Depth can exceed the ceiling by up to one batch, since the depth reading is
   * taken before the batch is sent.
   */
  let index = 0;
  while (index < candidates.length) {
    lastDepth = await queueDepth(sqs, queueUrl);
    await printProgress();

    if (lastDepth >= options.queueDepthCeiling) {
      await sleep(DEPTH_POLL_INTERVAL_MS);
      continue;
    }

    const room = Math.min(options.batchSize, options.queueDepthCeiling - lastDepth);
    const slice = candidates.slice(index, index + room);
    index += slice.length;

    // HeadObject before enqueueing, so an episode whose raw audio is missing does
    // not burn an invocation, fill a DLQ slot, or get marked waveform_status
    // 'failed' when the fix is re-downloading the audio, not re-running analysis.
    const present = await mapWithConcurrency(slice, options.concurrency, async (candidate) => {
      const exists = await rawObjectExists(s3, bucket, candidate.audioMediaId);
      return exists ? candidate : null;
    });

    const sendable: Candidate[] = [];
    for (const [i, candidate] of present.entries()) {
      if (candidate) {
        sendable.push(candidate);
      } else {
        stats.missingRaw++;
        missingRawIds.push(slice[i].episodeId);
      }
    }

    for (const entries of chunk(sendable, SQS_BATCH_MAX)) {
      const response = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: entries.map((candidate, i) => ({
            Id: String(i),
            MessageBody: analysisMessageBody(candidate),
          })),
        })
      );
      stats.enqueued += response.Successful?.length ?? 0;
      for (const failure of response.Failed ?? []) {
        console.error(
          `Failed to enqueue ${entries[Number(failure.Id)]?.episodeId}: ${failure.Code} ${failure.Message ?? ""}`
        );
      }
    }

    if (sendable.length > 0) {
      await sleep(DEPTH_POLL_INTERVAL_MS);
    }
  }

  console.log(`Enqueued ${stats.enqueued} analysis jobs, waiting for the queue to drain`);

  while (true) {
    lastDepth = await queueDepth(sqs, queueUrl);
    await printProgress();
    if (lastDepth === 0) break;
    await sleep(DEPTH_POLL_INTERVAL_MS);
  }

  await printProgress(true);

  const counts = await readStatusCounts(databaseUrl, options.seriesId);
  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.log(
    `Done in ${hours(elapsedSec)} hours (${elapsedSec.toFixed(0)}s): ` +
      `${stats.enqueued} enqueued, ${counts.ready - baseline.ready} ready, ` +
      `${counts.failed - baseline.failed} failed, ${stats.missingRaw} skipped for a missing raw object`
  );
  if (missingRawIds.length > 0) {
    console.log(`Episodes skipped for a missing raw object:\n${missingRawIds.join("\n")}`);
  }
}

// Guarded so the unit tests can import the helpers above without running a
// backfill.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
