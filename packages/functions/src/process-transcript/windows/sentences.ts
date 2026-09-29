/**
 * Sentence list for windows.bin, built from transcript.json audio_segments.
 *
 * Must match how graphiti builds its cues today
 * (topic_snapshot.bake_cues_from_audio_segments and _dedupe_audio_segments),
 * so the precomputed windows line up with graphiti's sentence timings.
 */

import type { TranscriptSegment } from '../types';

export interface Sentence {
  start: number;
  end: number;
  text: string;
}

export function buildSentences(audioSegments: TranscriptSegment[]): Sentence[] {
  const seen = new Set<string>();
  const sentences: Sentence[] = [];

  for (const seg of audioSegments) {
    const start = parseFloat(seg.start_time);
    const end = parseFloat(seg.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const text = seg.transcript ?? '';
    if (!text.trim()) continue;

    // Same key as graphiti: the raw start_time string plus the transcript.
    const key = `${seg.start_time}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);

    sentences.push({ start, end, text });
  }

  // Array.prototype.sort is stable, so equal starts keep transcript order.
  sentences.sort((a, b) => a.start - b.start);
  return sentences;
}
