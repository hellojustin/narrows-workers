/**
 * Backfill processed/{audioMediaId}/windows.bin for the existing catalogue (PROD-266).
 *
 * process-transcript writes windows.bin for newly ingested episodes (PROD-263).
 * This script writes it for episodes ingested before that, reading each
 * episode's transcript.json and calling the same writeWindowsFile.
 *
 * Usage:
 *   AWS_PROFILE=pond npm run backfill:windows -- --dry-run
 *   AWS_PROFILE=pond npm run backfill:windows -- --limit 20
 *   AWS_PROFILE=pond npm run backfill:windows -- --since 2026-09-15
 *   AWS_PROFILE=pond npm run backfill:windows
 *
 * Flags: --dry-run, --limit N, --series <uuid>, --since YYYY-MM-DD,
 *        --concurrency N (episodes in parallel, default 4), --force.
 *
 * Requires MEDIA_BUCKET_NAME, DATABASE_URL (read-only here; see runQuery) and,
 * except for --dry-run, OPENAI_API_KEY.
 *
 * Safe to stop and restart. writeWindowsFile skips an episode whose existing
 * file has the same format, model, dimension and transcript hash, so a re-run
 * only embeds what is missing or out of date. --force rewrites everything.
 */

import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import OpenAI from "openai";

import type { TranscriptResult } from "../packages/functions/src/process-transcript/types";
import { windowsEmbeddingSettings } from "../packages/functions/src/process-transcript/windows/embed";
import { WINDOWS_FORMAT_VERSION } from "../packages/functions/src/process-transcript/windows/encode";
import {
  isMissingObjectError,
  windowsKey,
  writeWindowsFile,
  type WriteWindowsStatus,
} from "../packages/functions/src/process-transcript/windows/write-windows";

/**
 * This script writes only windows.bin objects. It never sends a queue message:
 * re-running transcript ingest duplicates an episode's segments and chapters
 * (PROD-218). It reads transcript.json directly instead.
 */

const execFileAsync = promisify(execFile);

/**
 * Embedding tokens per hour of audio, measured on 60 random production
 * episodes (18.9 hours) on 2026-09-29 by building the 10s and 30s windows and
 * counting cl100k_base tokens. Per-episode median 122,000; p10 91,500; p90 170,800.
 */
const TOKENS_PER_AUDIO_HOUR = 143_600;

/** text-embedding-3-small list price per million tokens. Check current pricing. */
const USD_PER_MILLION_TOKENS = 0.02;

/** windows.bin bytes per hour of audio: about 830 sentences x 4,128 bytes. */
const BYTES_PER_AUDIO_HOUR = 3_430_000;

const PROGRESS_INTERVAL_MS = 30_000;
const HEAD_CONCURRENCY = 32;

/** psql unaligned output separator. Tabs cannot appear in a UUID or a number. */
const COLUMN_SEPARATOR = "\t";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface CliOptions {
  dryRun: boolean;
  force: boolean;
  limit?: number;
  seriesId?: string;
  since?: string;
  /** Episodes processed in parallel. Each runs up to 4 embedding requests. */
  concurrency: number;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, force: false, concurrency: 4 };

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
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--limit") {
      options.limit = positiveInt(arg, argv[++i]);
    } else if (arg === "--concurrency") {
      options.concurrency = positiveInt(arg, argv[++i]);
    } else if (arg === "--series") {
      const value = argv[++i];
      if (!value || !UUID_PATTERN.test(value)) {
        throw new Error(`--series requires a series UUID, got ${value ?? "nothing"}`);
      }
      options.seriesId = value;
    } else if (arg === "--since") {
      const value = argv[++i];
      if (!value || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
        throw new Error(`--since requires a date as YYYY-MM-DD, got ${value ?? "nothing"}`);
      }
      options.since = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export interface Candidate {
  episodeId: string;
  audioMediaId: string;
  durationSec: number;
}

/**
 * Episodes with audio, newest first, so the episodes most likely to be played
 * are covered first. psql -c takes no bind parameters; parseArgs has already
 * restricted seriesId to a UUID and since to a date.
 */
export function selectionSql(options: { seriesId?: string; since?: string; limit?: number }): string {
  const conditions = ["deleted_at IS NULL", "audio_media_id IS NOT NULL"];
  if (options.seriesId) conditions.push(`series_id = '${options.seriesId}'`);
  if (options.since) conditions.push(`published_at >= '${options.since}'`);
  return `
    SELECT id, audio_media_id, coalesce(duration, 0)
    FROM episodes
    WHERE ${conditions.join(" AND ")}
    ORDER BY published_at DESC NULLS LAST, id
    ${options.limit === undefined ? "" : `LIMIT ${options.limit}`}
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

export interface Estimate {
  audioHours: number;
  tokens: number;
  usd: number;
  storageGb: number;
}

export function estimate(totalDurationSec: number): Estimate {
  const audioHours = totalDurationSec / 3600;
  const tokens = audioHours * TOKENS_PER_AUDIO_HOUR;
  return {
    audioHours,
    tokens,
    usd: (tokens / 1_000_000) * USD_PER_MILLION_TOKENS,
    storageGb: (audioHours * BYTES_PER_AUDIO_HOUR) / 1e9,
  };
}

export type EpisodeStatus = WriteWindowsStatus | "no-transcript" | "failed";

export interface EpisodeResult {
  episodeId: string;
  audioMediaId: string;
  status: EpisodeStatus;
  sentenceCount?: number;
  bytes?: number;
  tokens?: number;
  error?: string;
}

export async function fetchTranscript(
  s3: S3Client,
  bucket: string,
  audioMediaId: string
): Promise<TranscriptResult | null> {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: `processed/${audioMediaId}/transcript.json` })
    );
    const body = await response.Body?.transformToString();
    return body ? (JSON.parse(body) as TranscriptResult) : null;
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
}

/** Write one episode's windows.bin. Never throws; failures are returned. */
export async function processEpisode(
  candidate: Candidate,
  deps: { s3: S3Client; openai: OpenAI; bucket: string; force: boolean }
): Promise<EpisodeResult> {
  const base = { episodeId: candidate.episodeId, audioMediaId: candidate.audioMediaId };
  try {
    const transcript = await fetchTranscript(deps.s3, deps.bucket, candidate.audioMediaId);
    const segments = transcript?.results?.audio_segments;
    if (!segments) {
      return { ...base, status: "no-transcript" };
    }
    const result = await writeWindowsFile({
      s3: deps.s3,
      openai: deps.openai,
      bucket: deps.bucket,
      audioMediaId: candidate.audioMediaId,
      audioSegments: segments,
      force: deps.force,
    });
    return {
      ...base,
      status: result.status,
      sentenceCount: result.sentenceCount,
      bytes: result.bytes,
      tokens: result.tokens,
    };
  } catch (error) {
    return { ...base, status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * For the dry run: whether a windows.bin with the current format, model and
 * dimension already exists. The transcript hash is not checked here, so a few
 * of these may still be rewritten if their transcript changed.
 */
async function hasCurrentFile(
  s3: S3Client,
  bucket: string,
  audioMediaId: string,
  model: string,
  dimensions: number
): Promise<boolean> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: windowsKey(audioMediaId) }));
    const meta = head.Metadata ?? {};
    return (
      meta["format-version"] === String(WINDOWS_FORMAT_VERSION) &&
      meta["embedding-model"] === model &&
      meta["embedding-dim"] === String(dimensions)
    );
  } catch (error) {
    if (isMissingObjectError(error)) return false;
    throw error;
  }
}

/**
 * Read-only query against the narrows database. default_transaction_read_only
 * is set for the psql session, so the server rejects any statement that would
 * write. The only writes this script makes are windows.bin objects in S3.
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const bucket = requireEnv("MEDIA_BUCKET_NAME");
  const databaseUrl = requireEnv("DATABASE_URL");
  const { model, dimensions } = windowsEmbeddingSettings();

  const candidates = toCandidates(await runQuery(databaseUrl, selectionSql(options)));
  const totalDurationSec = candidates.reduce((sum, c) => sum + c.durationSec, 0);
  const unknownDuration = candidates.filter((c) => c.durationSec === 0).length;

  console.log(`Episodes selected: ${candidates.length}`);
  console.log(`Embedding model: ${model}, ${dimensions} dimensions`);
  if (unknownDuration > 0) {
    console.log(`${unknownDuration} have no recorded duration and count as zero in the estimate`);
  }

  const s3 = new S3Client({});

  if (options.dryRun) {
    const current = await mapWithConcurrency(candidates, HEAD_CONCURRENCY, (c) =>
      hasCurrentFile(s3, bucket, c.audioMediaId, model, dimensions)
    );
    const pending = candidates.filter((_, i) => !current[i] || options.force);
    const pendingSec = pending.reduce((sum, c) => sum + c.durationSec, 0);
    const all = estimate(totalDurationSec);
    const todo = estimate(pendingSec);
    console.log(`Already have a current windows.bin: ${candidates.length - pending.length}`);
    console.log(`To write: ${pending.length} episodes, ${todo.audioHours.toFixed(1)} hours of audio`);
    console.log(
      `Projected embedding: ${(todo.tokens / 1e6).toFixed(0)}M tokens, ${usd(todo.usd)} ` +
        `at ${usd(USD_PER_MILLION_TOKENS)} per million (${TOKENS_PER_AUDIO_HOUR.toLocaleString()} tokens per audio hour, measured)`
    );
    console.log(`Projected S3 storage: ${todo.storageGb.toFixed(1)} GB (whole selection: ${all.storageGb.toFixed(1)} GB)`);
    console.log("Dry run — no transcripts read, nothing embedded or written");
    return;
  }

  const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

  const outputDir = join(process.cwd(), "scripts", "output");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, `backfill-windows-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  console.log(`Writing one line per episode to ${outputPath}`);

  const counts: Record<EpisodeStatus, number> = {
    written: 0,
    "skipped-current": 0,
    "skipped-empty": 0,
    "no-transcript": 0,
    failed: 0,
  };
  let tokens = 0;
  let bytes = 0;
  let done = 0;
  let lastProgressAt = 0;
  const startedAt = Date.now();

  function progress(force = false): void {
    if (!force && Date.now() - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = Date.now();
    const minutes = (Date.now() - startedAt) / 60_000;
    console.log(
      `[${new Date().toISOString()}] ${done}/${candidates.length} | written ${counts.written} | ` +
        `current ${counts["skipped-current"]} | empty ${counts["skipped-empty"]} | ` +
        `no transcript ${counts["no-transcript"]} | failed ${counts.failed} | ` +
        `${(tokens / 1e6).toFixed(1)}M tokens (${usd((tokens / 1e6) * USD_PER_MILLION_TOKENS)}) | ` +
        `${(bytes / 1e9).toFixed(2)} GB | ${minutes.toFixed(1)} min`
    );
  }

  await mapWithConcurrency(candidates, options.concurrency, async (candidate) => {
    const result = await processEpisode(candidate, { s3, openai, bucket, force: options.force });
    counts[result.status]++;
    tokens += result.tokens ?? 0;
    bytes += result.bytes ?? 0;
    done++;
    appendFileSync(outputPath, `${JSON.stringify(result)}\n`);
    if (result.status === "failed") {
      console.error(`FAILED ${result.episodeId} (${result.audioMediaId}): ${result.error}`);
    }
    progress();
  });

  progress(true);
  console.log(
    `Done. written ${counts.written}, already current ${counts["skipped-current"]}, ` +
      `empty transcript ${counts["skipped-empty"]}, no transcript ${counts["no-transcript"]}, ` +
      `failed ${counts.failed}. Embedding tokens ${tokens.toLocaleString()} (${usd((tokens / 1e6) * USD_PER_MILLION_TOKENS)}).`
  );
  if (counts.failed > 0) {
    console.log(`Re-run the same command to retry the ${counts.failed} failed episodes.`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
