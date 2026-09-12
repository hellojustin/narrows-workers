/**
 * S3 helpers shared by the container-image Lambdas.
 *
 * ffmpeg reads its input over HTTPS from a presigned URL rather than from a
 * downloaded file, which removes the input copy entirely. start-processing
 * already does this for AssemblyAI.
 *
 * Output is many small objects — a 3-hour episode produces roughly 1,080
 * segments — so uploads run concurrently with a bounded pool and per-object
 * retry.
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const s3Client = new S3Client({});

/**
 * Presigned GET expiry. Longer than the 15-minute Lambda ceiling so the URL
 * cannot expire mid-transcode, which would fail late and waste the whole run.
 */
const DEFAULT_INPUT_URL_TTL_SEC = 3600;

const DEFAULT_UPLOAD_CONCURRENCY = 16;
const DEFAULT_UPLOAD_ATTEMPTS = 3;

export function rawKey(mediaId: string): string {
  return `raw/${mediaId}`;
}

/**
 * Presigned HTTPS URL for the original audio, for ffmpeg to read directly.
 */
export async function presignedInputUrl(
  bucket: string,
  mediaId: string,
  expiresInSec = DEFAULT_INPUT_URL_TTL_SEC
): Promise<string> {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: bucket, Key: rawKey(mediaId) }),
    { expiresIn: expiresInSec }
  );
}

const CONTENT_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".aac": "audio/aac",
  ".ts": "video/mp2t",
  ".vtt": "text/vtt",
  ".json": "application/json",
  ".bin": "application/octet-stream",
};

export function contentTypeForKey(key: string): string {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] ?? "application/octet-stream";
}

export interface UploadItem {
  key: string;
  /** Local file to stream, or an in-memory body. Exactly one must be set. */
  filePath?: string;
  body?: Buffer | string;
  contentType?: string;
  cacheControl?: string;
}

async function putOnce(bucket: string, item: UploadItem): Promise<void> {
  const contentType = item.contentType ?? contentTypeForKey(item.key);

  if (item.filePath !== undefined) {
    // ContentLength is required when streaming: without it the SDK buffers the
    // whole file to compute a length, which defeats the point of streaming.
    const { size } = await stat(item.filePath);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: item.key,
        Body: createReadStream(item.filePath),
        ContentLength: size,
        ContentType: contentType,
        CacheControl: item.cacheControl,
      })
    );
    return;
  }

  if (item.body === undefined) {
    throw new Error(`Upload item for ${item.key} has neither filePath nor body`);
  }

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: item.key,
      Body: item.body,
      ContentType: contentType,
      CacheControl: item.cacheControl,
    })
  );
}

async function putWithRetry(bucket: string, item: UploadItem, attempts: number): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await putOnce(bucket, item);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      // A retried stream upload must reopen the file, which putOnce does.
      const backoffMs = 250 * 2 ** (attempt - 1);
      console.warn(
        `Upload of ${item.key} failed on attempt ${attempt}/${attempts}, retrying in ${backoffMs} ms:`,
        error instanceof Error ? error.message : error
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw new Error(
    `Failed to upload ${item.key} after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

/**
 * Upload many objects with bounded concurrency.
 *
 * Rejects if any object fails all its attempts, so a partial write surfaces as
 * a handler failure rather than as a silently incomplete stream.
 */
export async function uploadAll(
  bucket: string,
  items: UploadItem[],
  opts: { concurrency?: number; attempts?: number } = {}
): Promise<void> {
  const concurrency = opts.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY;
  const attempts = opts.attempts ?? DEFAULT_UPLOAD_ATTEMPTS;

  let nextIndex = 0;
  const failures: unknown[] = [];

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        await putWithRetry(bucket, items[index], attempts);
      } catch (error) {
        failures.push(error);
        // Stop claiming new work once something has failed; the whole run is
        // going to be retried by SQS anyway.
        nextIndex = items.length;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

  if (failures.length > 0) {
    throw failures[0];
  }
}

/** Upload a single object. */
export async function uploadOne(
  bucket: string,
  item: UploadItem,
  opts: { attempts?: number } = {}
): Promise<void> {
  await putWithRetry(bucket, item, opts.attempts ?? DEFAULT_UPLOAD_ATTEMPTS);
}
