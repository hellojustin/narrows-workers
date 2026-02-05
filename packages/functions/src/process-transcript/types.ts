/**
 * Types for process-transcript Lambda
 */

export interface TranscriptSegment {
  id: string;
  start_time: string;
  end_time: string;
  transcript: string;
  speaker_label: string;
  items?: number[]; // Word-level indices from AWS Transcribe (excluded from Graphiti)
}

/** TranscriptSegment without the 'items' array (for Graphiti metadata) */
export type CleanTranscriptSegment = Omit<TranscriptSegment, 'items'>;

export interface TranscriptResult {
  results: {
    audio_segments: TranscriptSegment[];
  };
}

export interface EpisodeData {
  id: string;
  seriesId: string;
  title: string;
  description: string;
  audioMediaId: string;
  publishedAt: string | null;
  duration: number | null;
}

export interface SeriesData {
  id: string;
  title: string;
  description: string;
}

export interface SpeakerInfo {
  name: string;
  role: 'host' | 'guest' | 'unknown';
}

export interface SpeakerData {
  [speakerId: string]: SpeakerInfo;
}

export type ChapterType = 'introduction' | 'credits' | 'promotion' | 'section' | 'other';

export interface Chapter {
  id: string;
  episodeId: string;
  type: ChapterType;
  title: string;
  summary: string | null;
  episodeStartSec: number;
  episodeEndSec: number;
}

export type SegmentType =
  | 'show-intro'
  | 'episode-intro'
  | 'guest-intro'
  | 'credits'
  | 'promotion'
  | 'summary'
  | 'analysis'
  | 'conclusion'
  | 'sound-only'
  | 'other';

export interface SegmentMetrics {
  lucidity: number; // 0-5
  polarity: number; // -5 to +5
  arousal: number; // 0-5
  subjectivity: number; // 0-5
  humor: number; // 0-5
}

export interface Segment {
  id: string;
  episodeId: string;
  chapterId: string | null;
  type: SegmentType;
  episodeStartSec: number;
  episodeEndSec: number;
  lucidity: number | null;
  polarity: number | null;
  arousal: number | null;
  subjectivity: number | null;
  humor: number | null;
  transcriptExcerpt: {
    context?: string;
    content: string;
  } | null;
}

export interface TranscriptProcessMessage {
  episodeId: string;
}
