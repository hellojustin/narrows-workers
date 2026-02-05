/**
 * Graphiti Ingestion Module
 *
 * Sends segments to Graphiti for knowledge graph ingestion.
 * Uses the new /data endpoint with structured metadata.
 */

import OpenAI from 'openai';
import type { SeriesData, EpisodeData, Segment, SpeakerData, TranscriptSegment } from './types';

const MAX_DATA_CHARS = 5000;

/**
 * Generate contextual summary for a segment using Anthropic's contextual retrieval format
 */
async function generateContextualRetrieval(
  openai: OpenAI,
  segment: Segment,
  series: SeriesData,
  episode: EpisodeData,
  speakerData: SpeakerData,
  transcriptText: string
): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are creating contextual descriptions for podcast transcript segments to improve retrieval in a knowledge graph.

Your task: Write a brief context that situates this chunk within the larger episode.

Follow Anthropic's contextual retrieval format:
- Keep it concise (1-3 sentences)
- Include relevant context from the episode/series that helps understand this chunk
- Reference the speaker(s), topic, and how this fits in the broader discussion

Example format:
"This segment from [series] discusses [topic]. [Speaker] explains [key point]. This is part of [broader context]."`,
        },
        {
          role: 'user',
          content: `Series: "${series.title}" - ${series.description || 'No description'}
Episode: "${episode.title}" - ${episode.description || 'No description'}
Segment Type: ${segment.type}
Time: ${formatTimestamp(segment.episodeStartSec)} - ${formatTimestamp(segment.episodeEndSec)}
Speakers: ${Object.entries(speakerData)
            .map(([id, info]) => `${id}: ${info.name} (${info.role})`)
            .join(', ')}

Transcript:
${transcriptText.slice(0, 2000)}

Write a brief contextual description for this segment.`,
        },
      ],
      max_tokens: 200,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content || '';
  } catch (error) {
    console.error('Error generating contextual retrieval:', error);
    return `Segment from "${series.title}" episode "${episode.title}". ${segment.type} at ${formatTimestamp(segment.episodeStartSec)}.`;
  }
}

/**
 * Format timestamp as MM:SS
 */
function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Get transcript segments that fall within a time range
 */
function getAudioSegmentsInRange(
  audioSegments: TranscriptSegment[],
  startSec: number,
  endSec: number
): TranscriptSegment[] {
  return audioSegments.filter((seg) => {
    const segStart = parseFloat(seg.start_time);
    const segEnd = parseFloat(seg.end_time);
    // Include segment if it overlaps with the range
    return segStart < endSec && segEnd > startSec;
  });
}

/**
 * Convert transcript segments to plain text
 */
function transcriptToText(segments: TranscriptSegment[]): string {
  return segments.map((seg) => seg.transcript).join(' ');
}

/**
 * Send a segment to Graphiti API
 */
async function sendToGraphiti(
  data: string,
  segment: Segment,
  series: SeriesData,
  episode: EpisodeData,
  audioSegments: TranscriptSegment[]
): Promise<string> {
  const graphitiUrl = process.env.GRAPHITI_API_URL;
  const graphitiKey = process.env.GRAPHITI_API_KEY;
  const graphId = process.env.GRAPHITI_GRAPH_ID;

  if (!graphitiUrl) {
    throw new Error('GRAPHITI_API_URL must be set');
  }

  if (!graphId) {
    throw new Error('GRAPHITI_GRAPH_ID must be set');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (graphitiKey) {
    headers['Authorization'] = `Bearer ${graphitiKey}`;
  }

  const response = await fetch(`${graphitiUrl}/data`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'json',
      data,
      group_id: graphId,
      created_at: episode.publishedAt || new Date().toISOString(),
      source_description: `${series.title}, ${episode.title}, segment ${segment.id}, ${formatTimestamp(segment.episodeStartSec)} - ${formatTimestamp(segment.episodeEndSec)}`,
      metadata: {
        // Series/Episode info
        series_id: series.id,
        series_title: series.title,
        episode_id: episode.id,
        episode_title: episode.title,
        // Segment info
        segment_id: segment.id,
        segment_type: segment.type,
        chapter_id: segment.chapterId,
        episode_start_sec: segment.episodeStartSec,
        episode_end_sec: segment.episodeEndSec,
        // Segment metrics
        lucidity: segment.lucidity,
        polarity: segment.polarity,
        arousal: segment.arousal,
        subjectivity: segment.subjectivity,
        humor: segment.humor,
        // Raw transcript segments (structured JSON)
        audio_segments: audioSegments,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Graphiti ingestion failed: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  return result.job_id || result.id || `segment-${segment.id}`;
}

/**
 * Chunk data if it exceeds the maximum size
 */
function chunkData(data: string): string[] {
  if (data.length <= MAX_DATA_CHARS) {
    return [data];
  }

  const chunks: string[] = [];
  let remaining = data;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_DATA_CHARS) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point (end of sentence or word)
    let breakPoint = MAX_DATA_CHARS;
    const periodIndex = remaining.lastIndexOf('. ', MAX_DATA_CHARS);
    const spaceIndex = remaining.lastIndexOf(' ', MAX_DATA_CHARS);

    if (periodIndex > MAX_DATA_CHARS * 0.7) {
      breakPoint = periodIndex + 1;
    } else if (spaceIndex > MAX_DATA_CHARS * 0.7) {
      breakPoint = spaceIndex;
    }

    chunks.push(remaining.slice(0, breakPoint).trim());
    remaining = remaining.slice(breakPoint).trim();
  }

  return chunks;
}

/**
 * Ingest segments to Graphiti
 *
 * @param openai - OpenAI client instance
 * @param segments - Identified segments to ingest
 * @param series - Series metadata
 * @param episode - Episode metadata
 * @param speakerData - Speaker information
 * @param audioSegments - Raw transcript segments from AWS Transcribe
 * @returns Array of Graphiti IDs
 */
export async function ingestSegmentsToGraphiti(
  openai: OpenAI,
  segments: Segment[],
  series: SeriesData,
  episode: EpisodeData,
  speakerData: SpeakerData,
  audioSegments: TranscriptSegment[]
): Promise<string[]> {
  const graphitiIds: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    console.log(`Ingesting segment ${i + 1}/${segments.length} (${segment.type})`);

    try {
      // Get the relevant audio segments for this time range
      const relevantAudioSegments = getAudioSegmentsInRange(
        audioSegments,
        segment.episodeStartSec,
        segment.episodeEndSec
      );

      // Convert to plain text for context generation and content
      const transcriptText = transcriptToText(relevantAudioSegments);

      // Generate contextual retrieval description
      const context = await generateContextualRetrieval(
        openai,
        segment,
        series,
        episode,
        speakerData,
        transcriptText
      );

      // Format data with contextual retrieval format
      const formattedData = `<document>
<context>${context}</context>
<transcript>
${transcriptText}
</transcript>
</document>`;

      // Chunk if necessary
      const dataChunks = chunkData(formattedData);

      for (let j = 0; j < dataChunks.length; j++) {
        const chunk = dataChunks[j];

        // Create a modified segment for tracking
        const chunkSegment = {
          ...segment,
          id: dataChunks.length > 1 ? `${segment.id}-chunk-${j}` : segment.id,
        };

        // For chunks, we include the full audio segments in metadata only on the first chunk
        const chunkAudioSegments = j === 0 ? relevantAudioSegments : [];

        const graphitiId = await sendToGraphiti(
          chunk,
          chunkSegment,
          series,
          episode,
          chunkAudioSegments
        );
        graphitiIds.push(graphitiId);

        if (j < dataChunks.length - 1) {
          // Small delay between chunks
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    } catch (error) {
      console.error(`Error ingesting segment ${segment.id}:`, error);
      // Continue with other segments
    }

    // Rate limiting delay between segments
    if (i < segments.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return graphitiIds;
}
