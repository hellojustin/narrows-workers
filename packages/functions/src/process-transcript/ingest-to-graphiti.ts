/**
 * Graphiti Ingestion Module
 *
 * Sends segments to Graphiti for knowledge graph ingestion.
 * Uses the new /data endpoint with structured metadata.
 */

import OpenAI from 'openai';
import type {
  SeriesData,
  EpisodeData,
  Segment,
  SpeakerData,
  TranscriptSegment,
  CleanTranscriptSegment,
} from './types';

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
export function formatTimestamp(seconds: number): string {
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
 * Convert transcript segments to plain text (without speaker names)
 */
function transcriptToText(segments: TranscriptSegment[]): string {
  return segments.map((seg) => seg.transcript).join(' ');
}

/**
 * Convert transcript segments to text with speaker names
 */
function transcriptToTextWithSpeakers(
  segments: TranscriptSegment[],
  speakerData: SpeakerData
): string {
  return segments
    .map((seg) => {
      const speakerName = speakerData[seg.speaker_label]?.name || seg.speaker_label;
      return `[${speakerName}] ${seg.transcript}`;
    })
    .join('\n');
}

/**
 * Clean audio segments for metadata (remove 'items' array)
 */
function cleanAudioSegments(segments: TranscriptSegment[]): CleanTranscriptSegment[] {
  return segments.map(({ id, start_time, end_time, transcript, speaker_label }) => ({
    id,
    start_time,
    end_time,
    transcript,
    speaker_label,
  }));
}

/**
 * Get actual time range from audio segments
 */
function getActualTimeRange(segments: TranscriptSegment[]): { startSec: number; endSec: number } {
  if (segments.length === 0) {
    return { startSec: 0, endSec: 0 };
  }
  const startSec = parseFloat(segments[0].start_time);
  const endSec = parseFloat(segments[segments.length - 1].end_time);
  return { startSec, endSec };
}

/**
 * Ellipsize a string to max length
 */
export function ellipsize(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * Segment types that should be saved to Narrows but NOT ingested to Graphiti
 */
const SKIP_GRAPHITI_TYPES = new Set(['promotion', 'credits', 'sound-only']);

const AD_KEYWORD_PATTERNS: RegExp[] = [
  // Strong signals (multi-word phrases, high confidence)
  /promo code/i,
  /use code/i,
  /discount code/i,
  /percent off/i,
  /% off/i,
  /visit\s+\S+\.com/i,
  /go to\s+\S+\.com/i,
  /brought to you by/i,
  /sponsored by/i,
  /\bsupported\b/i,
  /thanks to our sponsor/i,
  /sign up at/i,
  /free trial/i,
  /special offer/i,
  // Broad signals (single word / short phrase, widen the ambiguous zone)
  /\bsponsor\w*\b/i,
  /\boffer\b/i,
  /\bdeal\b/i,
  /\bcoupon\b/i,
  /\bsubscri(?:be|ption)\b/i,
  /\bdeliver(?:ed|y|s|ing)?\b/i,
  /\.com\b/i,
  /\bquick break\b/i,
  /we(?:'ll| will) be (?:right )?back/i,
  /\bword from\b/i,
  /\bsign up\b/i,
  /\bto your door\b/i,
  /\bget started\b/i,
  /\bcheck (?:it )?out\b/i,
  /\bfirst (?:order|month|purchase)\b/i,
];

/**
 * Count how many ad keyword patterns match in the given text.
 */
export function countAdKeywordMatches(text: string): number {
  return AD_KEYWORD_PATTERNS.filter((pattern) => pattern.test(text)).length;
}

/**
 * Classify ambiguous text as advertisement or content using an LLM.
 * Called when 1-2 keyword patterns matched (ambiguous zone).
 */
async function isAdvertisementLLM(openai: OpenAI, text: string): Promise<boolean> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a classifier that determines if podcast transcript text is an advertisement or sponsor segment.

Classify as ADVERTISEMENT if the text contains:
- Sponsor reads or mentions (e.g., "brought to you by", "sponsored by", "thanks to our sponsor")
- Promo codes or discount offers (e.g., "use code X for 20% off")
- Product pitches with URLs or calls to action (e.g., "visit example.com", "go to example.com/podcast")
- Mid-roll or pre/post-roll ad scripts
- Affiliate marketing content
- Native or brand-storytelling ads that describe a product or service in an aspirational or lifestyle-oriented way (e.g., a laundry service that "delivers to your door", a mattress brand promising better sleep)

Classify as CONTENT if the text is:
- Regular podcast discussion, interview, or conversation
- Educational or informational content
- Story narration or entertainment
- Host banter or show segments (even if briefly mentioning the show's own products/Patreon)

Respond with ONLY "ADVERTISEMENT" or "CONTENT".`,
        },
        {
          role: 'user',
          content: text.slice(0, 2000),
        },
      ],
      max_tokens: 10,
      temperature: 0,
    });

    const result = response.choices[0]?.message?.content?.trim().toUpperCase();
    return result === 'ADVERTISEMENT';
  } catch (error) {
    console.error('Error in LLM ad classification:', error);
    return false;
  }
}

/**
 * Chunk information for segments that were split due to size
 */
interface ChunkInfo {
  chunk_seq: number | null;
  chunk_total: number | null;
}

/**
 * Send a segment to Graphiti API
 */
async function sendToGraphiti(
  data: string,
  segment: Segment,
  series: SeriesData,
  episode: EpisodeData,
  audioSegments: TranscriptSegment[],
  actualStartSec: number,
  actualEndSec: number,
  chunkInfo: ChunkInfo = { chunk_seq: null, chunk_total: null }
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

  // Format timestamps for display
  const startTs = formatTimestamp(actualStartSec);
  const endTs = formatTimestamp(actualEndSec);

  // Generate name: "{series[12 chars]} - {episode[15 chars]} - {start}-{end}"
  const name = `${ellipsize(series.title, 12)} - ${ellipsize(episode.title, 15)} - ${startTs}-${endTs}`;

  // Clean audio segments (remove 'items' array)
  const cleanedAudioSegments = cleanAudioSegments(audioSegments);

  const response = await fetch(`${graphitiUrl}/data`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'json',
      data,
      name,
      group_id: graphId,
      created_at: episode.publishedAt || new Date().toISOString(),
      source_description: `${series.title}, ${episode.title}, segment ${segment.id}, ${startTs} - ${endTs}`,
      metadata: {
        // Series/Episode info
        series_id: series.id,
        series_title: series.title,
        episode_id: episode.id,
        episode_title: episode.title,
        published_at: episode.publishedAt || null,
        // Segment info
        segment_id: segment.id,
        segment_type: segment.type,
        chapter_id: segment.chapterId,
        // Chunk info (for segments split due to size)
        chunk_seq: chunkInfo.chunk_seq,
        chunk_total: chunkInfo.chunk_total,
        // Use actual transcript timestamps
        episode_start_sec: actualStartSec,
        episode_end_sec: actualEndSec,
        // Segment metrics
        lucidity: segment.lucidity,
        polarity: segment.polarity,
        arousal: segment.arousal,
        subjectivity: segment.subjectivity,
        humor: segment.humor,
        // Raw transcript segments (cleaned, without 'items')
        audio_segments: cleanedAudioSegments,
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
export function chunkData(data: string): string[] {
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

  // Filter out segments that should not be ingested to Graphiti
  const typeFiltered = segments.filter((seg) => !SKIP_GRAPHITI_TYPES.has(seg.type));
  const typeSkippedCount = segments.length - typeFiltered.length;

  if (typeSkippedCount > 0) {
    console.log(
      `Skipping ${typeSkippedCount} segments (promotion/credits/sound-only) for Graphiti ingestion`
    );
  }

  // Second-pass ad detection: keyword scan + LLM classifier for ambiguous cases
  const segmentsToIngest: Segment[] = [];
  let adSkippedCount = 0;

  for (const segment of typeFiltered) {
    const segAudio = getAudioSegmentsInRange(
      audioSegments,
      segment.episodeStartSec,
      segment.episodeEndSec
    );
    const plainText = transcriptToText(segAudio);
    const keywordHits = countAdKeywordMatches(plainText);

    if (keywordHits >= 3) {
      console.log(
        `Skipping segment ${segment.id} — detected as advertisement (${keywordHits} keyword matches)`
      );
      adSkippedCount++;
    } else if (keywordHits >= 1) {
      const isAd = await isAdvertisementLLM(openai, plainText);
      if (isAd) {
        console.log(
          `Skipping segment ${segment.id} — LLM classified as advertisement (${keywordHits} keyword match(es))`
        );
        adSkippedCount++;
      } else {
        segmentsToIngest.push(segment);
      }
    } else {
      segmentsToIngest.push(segment);
    }
  }

  if (adSkippedCount > 0) {
    console.log(`Skipping ${adSkippedCount} additional segments (ad detection) for Graphiti ingestion`);
  }

  for (let i = 0; i < segmentsToIngest.length; i++) {
    const segment = segmentsToIngest[i];
    console.log(`Ingesting segment ${i + 1}/${segmentsToIngest.length} (${segment.type})`);

    try {
      // Get the relevant audio segments for this time range
      const relevantAudioSegments = getAudioSegmentsInRange(
        audioSegments,
        segment.episodeStartSec,
        segment.episodeEndSec
      );

      // Get actual timestamps from the audio segments
      const { startSec: actualStartSec, endSec: actualEndSec } =
        getActualTimeRange(relevantAudioSegments);

      // Convert to text with speaker names for the content
      const transcriptText = transcriptToTextWithSpeakers(relevantAudioSegments, speakerData);

      // Generate contextual retrieval description (using plain text for LLM)
      const plainText = transcriptToText(relevantAudioSegments);
      const context = await generateContextualRetrieval(
        openai,
        segment,
        series,
        episode,
        speakerData,
        plainText
      );

      // Format data with contextual retrieval format (includes speaker names)
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

        // Log chunk info for debugging
        if (dataChunks.length > 1) {
          console.log(`Processing chunk ${j + 1}/${dataChunks.length} for segment ${segment.id}`);
        }

        // For chunks, we include the full audio segments in metadata only on the first chunk
        const chunkAudioSegments = j === 0 ? relevantAudioSegments : [];

        // Chunk metadata (null if not chunked)
        const chunkInfo = dataChunks.length > 1 
          ? { chunk_seq: j, chunk_total: dataChunks.length }
          : { chunk_seq: null, chunk_total: null };

        // Always pass the original segment - segment_id in Graphiti must match Narrows DB
        const graphitiId = await sendToGraphiti(
          chunk,
          segment,  // Use original segment, not a modified chunk version
          series,
          episode,
          chunkAudioSegments,
          actualStartSec,
          actualEndSec,
          chunkInfo
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
    if (i < segmentsToIngest.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return graphitiIds;
}
