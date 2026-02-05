/**
 * Segment Identification Module
 *
 * Uses LLM to identify 20-60 segments per hour of audio content.
 * Segments are 30s-5min long, can slightly overlap, and cover substantive content.
 */

import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import type {
  TranscriptSegment,
  SeriesData,
  EpisodeData,
  SpeakerData,
  Chapter,
  Segment,
  SegmentType,
} from './types';

interface SegmentIdentificationResult {
  segments: {
    type: SegmentType;
    start_sec: number;
    end_sec: number;
    lucidity: number;
    polarity: number;
    arousal: number;
    subjectivity: number;
    humor: number;
  }[];
}

/**
 * Get transcript text for a specific time range
 */
function getTranscriptForRange(
  segments: TranscriptSegment[],
  startSec: number,
  endSec: number,
  speakerData: SpeakerData
): string {
  return segments
    .filter((s) => {
      const segStart = parseFloat(s.start_time);
      const segEnd = parseFloat(s.end_time);
      return segStart >= startSec && segEnd <= endSec;
    })
    .map((s) => {
      const speakerName = speakerData[s.speaker_label]?.name || s.speaker_label;
      return `[${speakerName}] ${s.transcript}`;
    })
    .join(' ');
}

/**
 * Assign segments to chapters based on overlap
 */
function assignChapterToSegment(
  segmentStart: number,
  segmentEnd: number,
  chapters: Chapter[]
): string | null {
  // Find the chapter that contains the midpoint of the segment
  const midpoint = (segmentStart + segmentEnd) / 2;
  for (const chapter of chapters) {
    if (midpoint >= chapter.episodeStartSec && midpoint < chapter.episodeEndSec) {
      return chapter.id;
    }
  }
  return null;
}

/**
 * Build transcript summary for a chapter or time range
 */
function buildChapterTranscript(
  segments: TranscriptSegment[],
  speakerData: SpeakerData,
  startSec: number,
  endSec: number
): string {
  const relevantSegments = segments.filter((s) => {
    const segStart = parseFloat(s.start_time);
    return segStart >= startSec && segStart < endSec;
  });

  return relevantSegments
    .map((s) => {
      const speakerName = speakerData[s.speaker_label]?.name || s.speaker_label;
      const time = Math.floor(parseFloat(s.start_time));
      const mins = Math.floor(time / 60);
      const secs = time % 60;
      return `[${mins}:${secs.toString().padStart(2, '0')}] [${speakerName}] ${s.transcript}`;
    })
    .join('\n');
}

/**
 * Identify segments within a chapter using LLM
 */
async function identifySegmentsInChapter(
  openai: OpenAI,
  chapter: Chapter,
  transcriptText: string,
  targetSegments: number,
  series: SeriesData,
  episode: EpisodeData
): Promise<Omit<Segment, 'id' | 'episodeId' | 'chapterId' | 'transcriptExcerpt'>[]> {
  const chapterDuration = chapter.episodeEndSec - chapter.episodeStartSec;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an expert at analyzing podcast content. Your task is to identify ${targetSegments} segments within this chapter.

Segment requirements:
1. Each segment should be 30 seconds to 5 minutes long
2. Segments can slightly overlap (up to 10 seconds)
3. Focus on substantive content (skip pure filler or dead air)

Segment types:
- "show-intro": Standard show introduction
- "episode-intro": Introduction specific to this episode's topic
- "guest-intro": Introduction of a guest
- "credits": Acknowledgments, thank-yous
- "promotion": Advertisements, sponsor reads
- "summary": Summary of facts or events
- "analysis": Opinion, insight, commentary, point-of-view
- "conclusion": Wrapping up, key takeaways
- "sound-only": Music, sound effects with minimal speech
- "other": Doesn't fit other categories

Metrics (evaluate the dialogue in each segment):
- lucidity (0-5): How clearly expressed are the ideas? 0=meandering, 5=coherent/succinct
- polarity (-5 to +5): Sentiment. -5=negative, +5=positive
- arousal (0-5): Energy/intensity. 0=subdued, 5=raucous
- subjectivity (0-5): Fact vs opinion. 0=objective, 5=subjective
- humor (0-5): Humorous intent. 0=serious, 5=comedic

Output JSON:
{
  "segments": [
    {
      "type": "analysis",
      "start_sec": 120.5,
      "end_sec": 245.3,
      "lucidity": 4,
      "polarity": 2,
      "arousal": 3,
      "subjectivity": 4,
      "humor": 1
    }
  ]
}

IMPORTANT: start_sec and end_sec should be FLOAT values (with decimal precision) matching the transcript timestamps.

Note: start_sec and end_sec are relative to the EPISODE (not the chapter).
This chapter starts at ${chapter.episodeStartSec.toFixed(1)} and ends at ${chapter.episodeEndSec.toFixed(1)}.`,
        },
        {
          role: 'user',
          content: `Series: "${series.title}"
Episode: "${episode.title}"
Chapter: "${chapter.title}" (${chapter.type})
Chapter Time Range: ${chapter.episodeStartSec}s - ${chapter.episodeEndSec}s

Chapter Transcript:
${transcriptText.slice(0, 6000)}

Identify ${targetSegments} segments in this chapter.`,
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1500,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return [];
    }

    const result: SegmentIdentificationResult = JSON.parse(content);
    return result.segments.map((s) => ({
      type: s.type,
      episodeStartSec: Math.max(chapter.episodeStartSec, s.start_sec),
      episodeEndSec: Math.min(chapter.episodeEndSec, s.end_sec),
      lucidity: s.lucidity,
      polarity: s.polarity,
      arousal: s.arousal,
      subjectivity: s.subjectivity,
      humor: s.humor,
    }));
  } catch (error) {
    console.error(`Error identifying segments in chapter ${chapter.title}:`, error);
    return [];
  }
}

/**
 * Identify segments across all chapters using LLM
 *
 * @param openai - OpenAI client instance
 * @param series - Series metadata
 * @param episode - Episode metadata
 * @param segments - Transcript segments
 * @param speakerData - Identified speaker information
 * @param chapters - Previously identified chapters
 * @returns Array of segments
 */
export async function identifySegments(
  openai: OpenAI,
  series: SeriesData,
  episode: EpisodeData,
  transcriptSegments: TranscriptSegment[],
  speakerData: SpeakerData,
  chapters: Chapter[]
): Promise<Segment[]> {
  if (transcriptSegments.length === 0 || chapters.length === 0) {
    return [];
  }

  // Calculate target segments based on episode duration
  const episodeDuration = Math.max(
    ...transcriptSegments.map((s) => parseFloat(s.end_time))
  );
  const durationHours = episodeDuration / 3600;
  const totalTargetSegments = Math.max(20, Math.min(60, Math.round(durationHours * 40)));

  // Process each chapter
  const allSegments: Segment[] = [];

  for (const chapter of chapters) {
    // Calculate target segments for this chapter proportionally
    const chapterDuration = chapter.episodeEndSec - chapter.episodeStartSec;
    const chapterTargetSegments = Math.max(
      1,
      Math.round((chapterDuration / episodeDuration) * totalTargetSegments)
    );

    // Build transcript for this chapter
    const chapterTranscript = buildChapterTranscript(
      transcriptSegments,
      speakerData,
      chapter.episodeStartSec,
      chapter.episodeEndSec
    );

    // Identify segments in this chapter
    const chapterSegments = await identifySegmentsInChapter(
      openai,
      chapter,
      chapterTranscript,
      chapterTargetSegments,
      series,
      episode
    );

    // Add full segment data
    for (const seg of chapterSegments) {
      const transcriptExcerpt = getTranscriptForRange(
        transcriptSegments,
        seg.episodeStartSec,
        seg.episodeEndSec,
        speakerData
      );

      allSegments.push({
        id: uuidv4(),
        episodeId: episode.id,
        chapterId: chapter.id,
        type: seg.type,
        episodeStartSec: seg.episodeStartSec,
        episodeEndSec: seg.episodeEndSec,
        lucidity: seg.lucidity,
        polarity: seg.polarity,
        arousal: seg.arousal,
        subjectivity: seg.subjectivity,
        humor: seg.humor,
        transcriptExcerpt: transcriptExcerpt
          ? {
              content: transcriptExcerpt,
            }
          : null,
      });
    }

    // Small delay between chapters to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return allSegments;
}
