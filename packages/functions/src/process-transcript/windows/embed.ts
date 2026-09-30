/**
 * Batched embedding calls for windows.bin.
 *
 * Vectors are handed to `onVector` as each batch returns, so the caller can
 * write them straight into the output buffer instead of holding every vector.
 */

import type OpenAI from 'openai';

export const DEFAULT_WINDOWS_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_WINDOWS_EMBEDDING_DIM = 1024;

/** At most this many inputs per request. */
export const MAX_BATCH_INPUTS = 256;
/**
 * At most this many characters per request. The API caps the tokens summed
 * across one request; windows average about 150 characters, so this limit only
 * applies when a transcript has unusually long sentences.
 */
export const MAX_BATCH_CHARS = 400_000;
export const MAX_IN_FLIGHT = 4;
export const MAX_RETRIES = 5;

export interface EmbedOptions {
  model: string;
  dimensions: number;
  onVector: (index: number, vector: number[]) => void;
}

export function windowsEmbeddingSettings(env: NodeJS.ProcessEnv = process.env): {
  model: string;
  dimensions: number;
} {
  const dimensions = parseInt(env.WINDOWS_EMBEDDING_DIM ?? '', 10);
  return {
    model: env.WINDOWS_EMBEDDING_MODEL || DEFAULT_WINDOWS_EMBEDDING_MODEL,
    dimensions: Number.isFinite(dimensions) && dimensions > 0 ? dimensions : DEFAULT_WINDOWS_EMBEDDING_DIM,
  };
}

/** Split input indices into batches under both the input and character limits. */
export function planBatches(texts: string[]): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let chars = 0;
  texts.forEach((text, index) => {
    if (current.length > 0 && (current.length >= MAX_BATCH_INPUTS || chars + text.length > MAX_BATCH_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(index);
    chars += text.length;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Embed every text, at most MAX_IN_FLIGHT requests at a time.
 * Returns the tokens the API reported using.
 */
export async function embedTexts(openai: OpenAI, texts: string[], options: EmbedOptions): Promise<number> {
  const batches = planBatches(texts);
  let next = 0;
  let tokens = 0;

  async function worker(): Promise<void> {
    while (next < batches.length) {
      const batch = batches[next++];
      const response = await openai.embeddings.create(
        {
          model: options.model,
          dimensions: options.dimensions,
          input: batch.map((i) => texts[i]),
        },
        { maxRetries: MAX_RETRIES }
      );
      tokens += response.usage?.total_tokens ?? 0;
      if (response.data.length !== batch.length) {
        throw new Error(`embedding response had ${response.data.length} vectors for ${batch.length} inputs`);
      }
      for (const item of response.data) {
        options.onVector(batch[item.index], item.embedding);
      }
    }
  }

  const workers = Array.from({ length: Math.min(MAX_IN_FLIGHT, batches.length) }, () => worker());
  await Promise.all(workers);
  return tokens;
}
