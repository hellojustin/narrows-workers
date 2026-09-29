/**
 * Build, embed and upload processed/{audioMediaId}/windows.bin.
 *
 * Graphiti's clip shaping reads these vectors instead of embedding transcript
 * windows itself. Format: docs/windows-format.md.
 */

import { createHash } from 'node:crypto';
import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type OpenAI from 'openai';

import type { TranscriptSegment } from '../types';
import { buildSentences } from './sentences';
import { buildWindows } from './build-windows';
import { createWindowsFile, writeVector, WINDOWS_FORMAT_VERSION } from './encode';
import { embedTexts, windowsEmbeddingSettings } from './embed';

/** Window lengths in seconds, in the order they are stored in each row. */
export const WINDOW_SECS = [10, 30];

export function windowsKey(audioMediaId: string): string {
  return `processed/${audioMediaId}/windows.bin`;
}

export function isMissingObjectError(error: unknown): boolean {
  const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
}

export type WriteWindowsStatus = 'written' | 'skipped-current' | 'skipped-empty';

export interface WriteWindowsArgs {
  s3: S3Client;
  openai: OpenAI;
  bucket: string;
  audioMediaId: string;
  audioSegments: TranscriptSegment[];
  force?: boolean;
  /** Defaults to WINDOWS_EMBEDDING_MODEL / WINDOWS_EMBEDDING_DIM. */
  model?: string;
  dimensions?: number;
  /** For tests. */
  now?: () => Date;
}

export interface WriteWindowsResult {
  status: WriteWindowsStatus;
  sentenceCount: number;
  bytes?: number;
}

/** S3 object metadata that decides whether an existing file is current. */
export function windowsObjectMetadata(model: string, dimensions: number, transcriptSha256: string): Record<string, string> {
  return {
    'format-version': String(WINDOWS_FORMAT_VERSION),
    'embedding-model': model,
    'embedding-dim': String(dimensions),
    'transcript-sha256': transcriptSha256,
  };
}

async function headMetadata(s3: S3Client, bucket: string, key: string): Promise<Record<string, string> | null> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.Metadata ?? {};
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
}

export async function writeWindowsFile(args: WriteWindowsArgs): Promise<WriteWindowsResult> {
  const settings = windowsEmbeddingSettings();
  const model = args.model ?? settings.model;
  const dimensions = args.dimensions ?? settings.dimensions;

  const sentences = buildSentences(args.audioSegments);
  if (sentences.length === 0) {
    return { status: 'skipped-empty', sentenceCount: 0 };
  }

  const transcriptSha256 = createHash('sha256').update(JSON.stringify(sentences)).digest('hex');
  const key = windowsKey(args.audioMediaId);
  const expected = windowsObjectMetadata(model, dimensions, transcriptSha256);

  if (!args.force) {
    const existing = await headMetadata(args.s3, args.bucket, key);
    if (existing && Object.entries(expected).every(([k, v]) => existing[k] === v)) {
      return { status: 'skipped-current', sentenceCount: sentences.length };
    }
  }

  const windowSets = WINDOW_SECS.map((sec) => buildWindows(sentences, sec));
  const file = createWindowsFile({
    embeddingModel: model,
    embeddingDim: dimensions,
    windowSecs: WINDOW_SECS,
    transcriptSha256,
    generatedAt: (args.now?.() ?? new Date()).toISOString(),
    table: sentences.map((s, i) => ({
      sentStart: s.start,
      sentEnd: s.end,
      windowEnds: windowSets.map((set) => set[i].end),
    })),
  });

  // One request list covering both window lengths: index = w * N + row.
  const n = sentences.length;
  const texts = windowSets.flatMap((set) => set.map((w) => w.text));
  await embedTexts(args.openai, texts, {
    model,
    dimensions,
    onVector: (index, vector) => writeVector(file, index % n, Math.floor(index / n), vector),
  });

  await args.s3.send(
    new PutObjectCommand({
      Bucket: args.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: 'application/octet-stream',
      Metadata: expected,
    })
  );

  return { status: 'written', sentenceCount: n, bytes: file.buffer.length };
}
