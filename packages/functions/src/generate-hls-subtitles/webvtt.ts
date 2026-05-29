/**
 * WebVTT subtitle generation for HLS — aligned to audio segment boundaries.
 *
 * Sentence assembly mirrors pond-mobile TranscriptSentence.fromItems.
 */

export interface TranscriptItem {
  start_time: string;
  end_time: string;
  type: "pronunciation" | "punctuation";
  alternatives: { confidence: string; content: string }[];
  speaker_label?: string;
}

export interface Sentence {
  text: string;
  startTime: number;
  endTime: number;
}

export interface SegmentBoundary {
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface SubtitleSegmentFile {
  filename: string;
  content: string;
}

const SENTENCE_ENDERS = new Set([".", "?", "!"]);
const MAX_WORDS_BEFORE_FORCE_SPLIT = 60;
const MPEGTS_TIMESCALE = 90000;

function parseTimeSec(value: string): number {
  return parseFloat(value) || 0;
}

function formatVttTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  const wholeSecs = Math.floor(secs);
  const millis = Math.round((secs - wholeSecs) * 1000);

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(wholeSecs).padStart(2, "0");
  const ms = String(millis).padStart(3, "0");

  return `${hh}:${mm}:${ss}.${ms}`;
}

function getItemContent(item: TranscriptItem): string {
  return item.alternatives[0]?.content ?? "";
}

/**
 * Port of pond-mobile TranscriptSentence.fromItems.
 */
export function buildSentences(items: TranscriptItem[]): Sentence[] {
  const sentences: Sentence[] = [];
  let buffer = "";
  let sentenceStart: number | null = null;
  let lastWordEnd = 0;
  let wordCount = 0;

  const flush = () => {
    const text = buffer.trim();
    if (text.length > 0 && sentenceStart !== null) {
      sentences.push({
        text,
        startTime: sentenceStart,
        endTime: lastWordEnd,
      });
    }
    buffer = "";
    sentenceStart = null;
    wordCount = 0;
  };

  for (const item of items) {
    if (item.type === "pronunciation") {
      if (buffer.length > 0) buffer += " ";
      buffer += getItemContent(item);
      sentenceStart ??= parseTimeSec(item.start_time);
      lastWordEnd = parseTimeSec(item.end_time);
      wordCount++;

      if (wordCount >= MAX_WORDS_BEFORE_FORCE_SPLIT) {
        flush();
      }
    } else if (item.type === "punctuation") {
      const punct = getItemContent(item);
      buffer += punct;

      if (SENTENCE_ENDERS.has(punct)) {
        flush();
      }
    }
  }

  flush();
  return sentences;
}

/**
 * Parse an HLS media playlist and build cumulative segment boundaries.
 */
export function parseAudioPlaylist(m3u8Content: string): SegmentBoundary[] {
  const lines = m3u8Content.split(/\r?\n/);
  const boundaries: SegmentBoundary[] = [];
  let cursor = 0;
  let index = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXTINF:")) continue;

    const durationMatch = line.match(/^#EXTINF:([\d.]+)/);
    if (!durationMatch) continue;

    const durationSec = parseFloat(durationMatch[1]);
    const startSec = cursor;
    const endSec = cursor + durationSec;

    boundaries.push({
      index,
      startSec,
      endSec,
      durationSec,
    });

    cursor = endSec;
    index++;
  }

  return boundaries;
}

function sentenceOverlapsSegment(sentence: Sentence, boundary: SegmentBoundary): boolean {
  return sentence.endTime > boundary.startSec && sentence.startTime < boundary.endSec;
}

function formatCueTimes(sentence: Sentence): string {
  return `${formatVttTime(sentence.startTime)} --> ${formatVttTime(sentence.endTime)}`;
}

/**
 * Generate WebVTT segment files aligned to HLS audio segment boundaries.
 * Sentences spanning a boundary appear in both segments (HLS spec).
 */
export function generateSubtitleSegments(
  sentences: Sentence[],
  segmentBoundaries: SegmentBoundary[]
): SubtitleSegmentFile[] {
  return segmentBoundaries.map((boundary) => {
    const overlapping = sentences.filter((s) => sentenceOverlapsSegment(s, boundary));
    const mpegts = Math.round(boundary.startSec * MPEGTS_TIMESCALE);

    const lines = ["WEBVTT", `X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${mpegts}`, ""];

    for (const sentence of overlapping) {
      lines.push(formatCueTimes(sentence));
      lines.push(sentence.text);
      lines.push("");
    }

    const content = lines.join("\n").trimEnd() + "\n";
    const filename = `transcript_${String(boundary.index + 1).padStart(5, "0")}.vtt`;

    return { filename, content };
  });
}

/**
 * Build subtitle media playlist mirroring audio EXTINF durations.
 */
export function buildSubtitlePlaylist(segmentBoundaries: SegmentBoundary[]): string {
  const maxDuration = segmentBoundaries.reduce(
    (max, b) => Math.max(max, b.durationSec),
    0
  );
  const targetDuration = Math.ceil(maxDuration);

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];

  for (const boundary of segmentBoundaries) {
    const filename = `transcript_${String(boundary.index + 1).padStart(5, "0")}.vtt`;
    lines.push(`#EXTINF:${boundary.durationSec.toFixed(6)},`);
    lines.push(filename);
  }

  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

/**
 * Returns null if manifest already advertises subtitles (idempotent).
 */
export function patchMasterManifest(manifest: string): string | null {
  if (manifest.includes('SUBTITLES="subs"')) {
    return null;
  }

  const lines = manifest.split(/\r?\n/);
  const output: string[] = [];
  let mediaLineAdded = false;

  for (const line of lines) {
    if (!mediaLineAdded && line.startsWith("#EXT-X-STREAM-INF:")) {
      output.push(
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Transcript",DEFAULT=NO,AUTOSELECT=YES,LANGUAGE="en",URI="transcript.m3u8"'
      );
      mediaLineAdded = true;

      if (!line.includes('SUBTITLES="subs"')) {
        output.push(`${line},SUBTITLES="subs"`);
        continue;
      }
    }

    output.push(line);
  }

  if (!mediaLineAdded) {
    throw new Error("Master manifest has no #EXT-X-STREAM-INF line to patch");
  }

  return output.join("\n") + (manifest.endsWith("\n") ? "\n" : "");
}

export function masterManifestHasSubtitles(manifest: string): boolean {
  return manifest.includes('SUBTITLES="subs"');
}
