/**
 * Chapter Identification Module
 *
 * Uses LLM to identify 5-15 chapters per hour of audio content.
 * Chapters are non-overlapping, cover the entire duration, and are at least 30 seconds long.
 */

import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import type {
  TranscriptSegment,
  SeriesData,
  EpisodeData,
  SpeakerData,
  Chapter,
  ChapterType,
} from './types';

interface ChapterIdentificationResult {
  chapters: {
    type: ChapterType;
    title: string;
    summary: string;
    start_sec: number;
    end_sec: number;
  }[];
}

/**
 * Build a condensed transcript view for the LLM
 */
function buildTranscriptSummary(
  segments: TranscriptSegment[],
  speakerData: SpeakerData
): string {
  // Group segments into time-based blocks (every 30 seconds)
  const blockDuration = 30;
  const blocks: { time: number; text: string }[] = [];

  for (const segment of segments) {
    const startTime = parseFloat(segment.start_time);
    const blockIndex = Math.floor(startTime / blockDuration);
    const blockTime = blockIndex * blockDuration;

    // Get speaker name if available
    const speakerName = speakerData[segment.speaker_label]?.name || segment.speaker_label;

    const text = `[${speakerName}] ${segment.transcript}`;

    if (!blocks[blockIndex]) {
      blocks[blockIndex] = { time: blockTime, text: '' };
    }
    blocks[blockIndex].text += (blocks[blockIndex].text ? ' ' : '') + text;
  }

  // Format as condensed timeline
  return blocks
    .filter((b) => b)
    .map((block) => {
      const mins = Math.floor(block.time / 60);
      const secs = Math.floor(block.time % 60);
      const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
      // Truncate each block to 300 chars
      const truncatedText =
        block.text.length > 300 ? block.text.slice(0, 300) + '...' : block.text;
      return `[${timeStr}] ${truncatedText}`;
    })
    .join('\n');
}

/**
 * Identify chapters in the transcript using LLM
 *
 * @param openai - OpenAI client instance
 * @param series - Series metadata
 * @param episode - Episode metadata
 * @param segments - Transcript segments
 * @param speakerData - Identified speaker information
 * @returns Array of chapters
 */
export async function identifyChapters(
  openai: OpenAI,
  series: SeriesData,
  episode: EpisodeData,
  segments: TranscriptSegment[],
  speakerData: SpeakerData
): Promise<Chapter[]> {
  if (segments.length === 0) {
    return [];
  }

  // Calculate episode duration from segments
  const episodeDuration = Math.max(...segments.map((s) => parseFloat(s.end_time)));
  const durationMinutes = episodeDuration / 60;

  // Target 5-15 chapters per hour
  const targetChapters = Math.max(5, Math.min(15, Math.round(durationMinutes / 4)));

  const transcriptSummary = buildTranscriptSummary(segments, speakerData);

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an expert at dividing podcast episodes into meaningful chapters. Your task is to identify ${targetChapters} chapters (±3) for this episode.

Chapter requirements:
1. Each chapter must be at least 30 seconds long
2. Chapters must NOT overlap
3. Chapters must cover the ENTIRE episode duration (0 to ${Math.round(episodeDuration)} seconds)
4. Each chapter should be consumable on its own with minimal prior context

Chapter types:
- "introduction": Opening segment, welcome, topic preview
- "credits": Thanking staff, guests, sponsors at the end
- "promotion": Advertisements or sponsor segments
- "section": Main content sections (most common)
- "other": Anything that doesn't fit the above

Output JSON in this format:
{
  "chapters": [
    {
      "type": "introduction",
      "title": "Short 2-4 word title",
      "summary": "1-4 sentence summary of this chapter",
      "start_sec": 0.0,
      "end_sec": 182.5
    }
  ]
}

IMPORTANT: start_sec and end_sec should be FLOAT values (with decimal precision) matching the transcript timestamps.

Guidelines:
- First chapter MUST start at 0.0
- Last chapter MUST end at approximately ${episodeDuration.toFixed(1)}
- Each chapter's end_sec should equal the next chapter's start_sec
- Titles should be short and descriptive (2-4 words)
- Summaries should help someone decide if they want to listen to this section`,
        },
        {
          role: 'user',
          content: `Series: "${series.title}"
Episode: "${episode.title}"
Episode Description: ${episode.description || 'No description'}
Duration: ${Math.round(durationMinutes)} minutes

Identified Speakers:
${Object.entries(speakerData)
  .map(([id, info]) => `- ${id}: ${info.name} (${info.role})`)
  .join('\n')}

Transcript Timeline:
${transcriptSummary}

Please identify the chapters.`,
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2000,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error('No response from chapter identification');
      return createDefaultChapters(episode.id, episodeDuration);
    }

    const result: ChapterIdentificationResult = JSON.parse(content);

    // Convert to Chapter format with UUIDs
    const chapters: Chapter[] = result.chapters.map((ch) => ({
      id: uuidv4(),
      episodeId: episode.id,
      type: ch.type,
      title: ch.title,
      summary: ch.summary,
      episodeStartSec: ch.start_sec,
      episodeEndSec: ch.end_sec,
    }));

    // Validate and fix chapter boundaries
    return validateAndFixChapters(chapters, episodeDuration, episode.id);
  } catch (error) {
    console.error('Error identifying chapters:', error);
    return createDefaultChapters(episode.id, episodeDuration);
  }
}

/**
 * Create default chapters when identification fails
 */
function createDefaultChapters(episodeId: string, duration: number): Chapter[] {
  // Create 3 basic chapters: intro, main, outro
  const introEnd = Math.min(60, duration * 0.1);
  const outroStart = Math.max(duration - 60, duration * 0.9);

  return [
    {
      id: uuidv4(),
      episodeId,
      type: 'introduction',
      title: 'Introduction',
      summary: 'Episode introduction',
      episodeStartSec: 0,
      episodeEndSec: introEnd,
    },
    {
      id: uuidv4(),
      episodeId,
      type: 'section',
      title: 'Main Content',
      summary: 'Main episode content',
      episodeStartSec: introEnd,
      episodeEndSec: outroStart,
    },
    {
      id: uuidv4(),
      episodeId,
      type: 'credits',
      title: 'Closing',
      summary: 'Episode conclusion and credits',
      episodeStartSec: outroStart,
      episodeEndSec: duration,
    },
  ];
}

/**
 * Validate and fix chapter boundaries to ensure full coverage
 */
function validateAndFixChapters(
  chapters: Chapter[],
  duration: number,
  episodeId: string
): Chapter[] {
  if (chapters.length === 0) {
    return createDefaultChapters(episodeId, duration);
  }

  // Sort by start time
  chapters.sort((a, b) => a.episodeStartSec - b.episodeStartSec);

  // Fix first chapter to start at 0
  if (chapters[0].episodeStartSec > 0) {
    chapters[0].episodeStartSec = 0;
  }

  // Fix last chapter to end at duration
  if (chapters[chapters.length - 1].episodeEndSec < duration) {
    chapters[chapters.length - 1].episodeEndSec = duration;
  }

  // Ensure no gaps between chapters
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i].episodeStartSec !== chapters[i - 1].episodeEndSec) {
      chapters[i].episodeStartSec = chapters[i - 1].episodeEndSec;
    }
  }

  // Filter out chapters that are too short (< 10 seconds after adjustments)
  return chapters.filter((ch) => ch.episodeEndSec - ch.episodeStartSec >= 10);
}
