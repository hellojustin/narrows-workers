/**
 * Sliding transcript windows for windows.bin.
 *
 * Must match graphiti's topic_mention.build_windows: a window starts at a
 * sentence and takes following sentences until it spans the target length.
 */

import type { Sentence } from './sentences';

/** Longest window text sent to the embedding model. */
export const MAX_WINDOW_CHARS = 8000;

export interface TranscriptWindow {
  startIndex: number;
  endIndex: number;
  start: number;
  end: number;
  text: string;
}

/** One window of `windowSec` seconds starting at every sentence. */
export function buildWindows(sentences: Sentence[], windowSec: number): TranscriptWindow[] {
  const windows: TranscriptWindow[] = [];

  for (let i = 0; i < sentences.length; i++) {
    const start = sentences[i].start;
    let j = i;
    // Take sentences until one reaches the length; that sentence is included.
    // If the transcript ends first, the window runs to the last sentence.
    while (j < sentences.length - 1 && sentences[j].end - start < windowSec) {
      j++;
    }

    const text = sentences
      .slice(i, j + 1)
      .map((s) => s.text)
      .join(' ')
      .slice(0, MAX_WINDOW_CHARS);

    windows.push({ startIndex: i, endIndex: j, start, end: sentences[j].end, text });
  }

  return windows;
}
