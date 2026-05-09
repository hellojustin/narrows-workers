/**
 * Adapter: converts AssemblyAI transcript responses to the TranscriptResult format
 * used by all downstream systems (process-transcript pipeline, mobile app, dashboard).
 *
 * The existing format was defined by AWS Transcribe. We synthesize its structure
 * so no changes are needed in consumers.
 */

import type { AssemblyAIWord, AssemblyAISentence } from "./types";

// Target format — matches packages/functions/src/process-transcript/types.ts
interface TranscriptItem {
  start_time: string;
  end_time: string;
  type: "pronunciation" | "punctuation";
  alternatives: { confidence: string; content: string }[];
  speaker_label?: string;
}

interface TranscriptSegment {
  id: string;
  start_time: string;
  end_time: string;
  transcript: string;
  speaker_label: string;
}

export interface TranscriptResult {
  results: {
    audio_segments: TranscriptSegment[];
    items: TranscriptItem[];
  };
}

// Punctuation characters that sentence splitters care about
const PUNCTUATION_CHARS = new Set([".", ",", "?", "!", ";", ":"]);

/**
 * Map AssemblyAI speaker letter ("A", "B", ...) to AWS Transcribe-style label
 * ("spk_0", "spk_1", ...). Null speaker defaults to spk_0.
 */
export function mapSpeaker(speaker: string | null): string {
  if (!speaker) return "spk_0";
  const index = speaker.charCodeAt(0) - "A".charCodeAt(0);
  return `spk_${index}`;
}

/**
 * Convert milliseconds integer to seconds string.
 * e.g. 5230 -> "5.23"
 */
export function msToSecondsString(ms: number): string {
  return (ms / 1000).toString();
}

/**
 * Synthesize an items array with separate punctuation entries from AssemblyAI words.
 *
 * AssemblyAI embeds trailing punctuation directly in word text: "Hello," or "world."
 * The mobile app (pond-mobile TranscriptSentence.fromItems) expects punctuation as
 * separate items with type: "punctuation" and uses ".", "?", "!" to split sentences.
 *
 * For each word:
 *   1. Strip trailing punctuation chars from the word text.
 *   2. Emit a "pronunciation" item for the remaining word text (if non-empty).
 *   3. Emit a "punctuation" item for each stripped char.
 *
 * Punctuation items share the end timestamp of the parent word and have confidence "0.0".
 */
export function synthesizeItems(words: AssemblyAIWord[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];

  for (const word of words) {
    let text = word.text;
    const trailingPunct: string[] = [];

    // Strip trailing punctuation — handles "word." "word," "word?!" etc.
    while (text.length > 0 && PUNCTUATION_CHARS.has(text[text.length - 1])) {
      trailingPunct.unshift(text[text.length - 1]);
      text = text.slice(0, -1);
    }

    // Emit pronunciation item (only when there's actual word content left)
    if (text.length > 0) {
      items.push({
        start_time: msToSecondsString(word.start),
        end_time: msToSecondsString(word.end),
        type: "pronunciation",
        alternatives: [{ confidence: String(word.confidence), content: text }],
        speaker_label: mapSpeaker(word.speaker),
      });
    }

    // Emit one punctuation item per stripped character
    for (const punct of trailingPunct) {
      items.push({
        start_time: msToSecondsString(word.end),
        end_time: msToSecondsString(word.end),
        type: "punctuation",
        alternatives: [{ confidence: "0.0", content: punct }],
      });
    }
  }

  return items;
}

/**
 * Convert AssemblyAI sentences to audio_segments — the speaker-labeled, timed
 * chunks read by process-transcript for speaker identification, chapters, etc.
 */
export function buildAudioSegments(sentences: AssemblyAISentence[]): TranscriptSegment[] {
  return sentences.map((sentence, index) => ({
    id: String(index),
    start_time: msToSecondsString(sentence.start),
    end_time: msToSecondsString(sentence.end),
    transcript: sentence.text,
    speaker_label: mapSpeaker(sentence.speaker),
  }));
}

/**
 * Main adapter: converts AssemblyAI words + sentences into the TranscriptResult
 * format that all downstream consumers expect.
 */
export function adaptToTranscriptResult(
  words: AssemblyAIWord[],
  sentences: AssemblyAISentence[]
): TranscriptResult {
  return {
    results: {
      audio_segments: buildAudioSegments(sentences),
      items: synthesizeItems(words),
    },
  };
}
