/**
 * S3 helpers shared by the ffmpeg Lambdas.
 *
 * Input is downloaded to /tmp rather than read by ffmpeg over HTTPS. The layer's
 * ffmpeg is statically linked, and a static glibc binary cannot resolve hostnames:
 * glibc does DNS through NSS modules it dlopens at runtime, which a static binary
 * has no way to load. Passing a presigned URL fails with "Failed to resolve
 * hostname ...: System error" even though the binary itself runs. Verified on
 * Lambda. Downloading first costs about two seconds in-region for a 212 MB file,
 * against a transcode measured in minutes, and it removes any chance of the
 * presigned URL expiring part-way through.
 *
 * Output is many small objects — a 3-hour episode produces roughly 1,080
 * segments — so uploads run concurrently with a bounded pool and per-object
 * retry.
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import path from "node:path";

const s3Client = new S3Client({});

/**
 * Presigned GET expiry. Longer than the 15-minute Lambda ceiling so the URL
 * cannot expire mid-run.
 *
 * Still used for services that fetch the audio themselves, such as AssemblyAI.
 * ffmpeg cannot use one; see the note above.
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

/**
 * Download the original audio to a local path for ffmpeg to read.
 *
 * Streamed to disk rather than buffered: the largest source in the catalogue is
 * about 400 MB, and holding that in memory alongside the transcode is wasteful
 * when /tmp is already provisioned for the output.
 */
export async function downloadRawAudio(
  bucket: string,
  mediaId: string,
  destinationPath: string
): Promise<{ bytes: number }> {
  await mkdir(path.dirname(destinationPath), { recursive: true });

  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: rawKey(mediaId) })
  );
  if (!response.Body) {
    throw new Error(`No body returned for s3://${bucket}/${rawKey(mediaId)}`);
  }

  await pipeline(response.Body as Readable, createWriteStream(destinationPath));

  const { size } = await stat(destinationPath);
  if (size === 0) {
    throw new Error(`Downloaded s3://${bucket}/${rawKey(mediaId)} but the file is empty`);
  }
  // A short read produces a file ffmpeg will happily transcode into a truncated
  // stream, so compare against the length S3 reported.
  if (response.ContentLength !== undefined && size !== response.ContentLength) {
    throw new Error(
      `Downloaded ${size} bytes of s3://${bucket}/${rawKey(mediaId)} but S3 reported ` +
        `${response.ContentLength}`
    );
  }

  return { bytes: size };
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
  body?: Buffer | Uint8Array | string;
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
