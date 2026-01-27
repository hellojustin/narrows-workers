import type { SQSEvent, SQSHandler } from "aws-lambda";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import OpenAI from "openai";

const s3Client = new S3Client({});

interface TranscriptIngestMessage {
  episodeId: string;
}

interface TranscriptSegment {
  id: string;
  start_time: string;
  end_time: string;
  transcript: string;
  speaker_label: string;
}

interface TranscriptResult {
  results: {
    audio_segments: TranscriptSegment[];
  };
}

interface EpisodeData {
  id: string;
  seriesId: string;
  title: string;
  description: string;
  audioMediaId: string;
}

interface SeriesData {
  id: string;
  title: string;
  description: string;
}

interface TranscriptChunk {
  speakerLabel: string;
  lines: TranscriptSegment[];
  startTime: number;
  endTime: number;
  text: string;
}

const MAX_CHUNK_CHARS = 4000; // Smaller than podsearch-lambdas' 6000

/**
 * Fetch episode data from Narrows API
 */
async function fetchEpisode(episodeId: string): Promise<EpisodeData | null> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  const response = await fetch(`${apiUrl}/api/v1/episodes/${episodeId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) return null;
  const { data } = await response.json();
  return data as EpisodeData;
}

/**
 * Fetch series data from Narrows API
 */
async function fetchSeries(seriesId: string): Promise<SeriesData | null> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  const response = await fetch(`${apiUrl}/api/v1/series/${seriesId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) return null;
  const { data } = await response.json();
  return data as SeriesData;
}

/**
 * Fetch transcript from S3
 */
async function fetchTranscript(
  bucketName: string,
  audioMediaId: string
): Promise<TranscriptResult> {
  const key = `processed/${audioMediaId}/transcript.json`;

  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    })
  );

  const body = await response.Body?.transformToString();
  if (!body) {
    throw new Error("Empty transcript file");
  }

  return JSON.parse(body) as TranscriptResult;
}

/**
 * Group transcript segments by speaker, keeping under max size
 */
function chunkBySpeaker(segments: TranscriptSegment[]): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let currentChunk: TranscriptChunk | null = null;

  for (const segment of segments) {
    const segmentText = `${segment.speaker_label}: ${segment.transcript}`;
    const segmentSize = segmentText.length;

    // Start new chunk if different speaker or would exceed size
    if (
      !currentChunk ||
      currentChunk.speakerLabel !== segment.speaker_label ||
      currentChunk.text.length + segmentSize > MAX_CHUNK_CHARS
    ) {
      // Save current chunk if exists
      if (currentChunk) {
        chunks.push(currentChunk);
      }

      // Start new chunk
      currentChunk = {
        speakerLabel: segment.speaker_label,
        lines: [segment],
        startTime: parseFloat(segment.start_time),
        endTime: parseFloat(segment.end_time),
        text: segmentText,
      };
    } else {
      // Add to current chunk
      currentChunk.lines.push(segment);
      currentChunk.endTime = parseFloat(segment.end_time);
      currentChunk.text += "\n" + segmentText;
    }
  }

  // Don't forget the last chunk
  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Generate contextual summary for a chunk using OpenAI
 */
async function generateChunkContext(
  openai: OpenAI,
  seriesTitle: string,
  episodeTitle: string,
  speakerLabel: string,
  chunkText: string
): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant that creates succinct context descriptions for podcast transcript chunks. Keep your response to 1-2 sentences.",
        },
        {
          role: "user",
          content: `This is a transcript chunk from the podcast "${seriesTitle}", episode "${episodeTitle}". The speaker is ${speakerLabel}. Please provide a brief context summary (1-2 sentences) describing what this chunk is about:\n\n${chunkText.slice(0, 1500)}`,
        },
      ],
      max_tokens: 150,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content || "";
  } catch (error) {
    console.error("Error generating context:", error);
    return `Transcript chunk from ${seriesTitle} - ${episodeTitle}, spoken by ${speakerLabel}`;
  }
}

/**
 * Format timestamp as MM:SS
 */
function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Send chunk to Graphiti API
 */
async function ingestChunkToGraphiti(
  chunk: TranscriptChunk,
  context: string,
  seriesData: SeriesData,
  episodeData: EpisodeData,
  chunkIndex: number,
  totalChunks: number
): Promise<string> {
  const graphitiUrl = process.env.GRAPHITI_API_URL;
  const graphitiKey = process.env.GRAPHITI_API_KEY;

  if (!graphitiUrl) {
    throw new Error("GRAPHITI_API_URL must be set");
  }

  // Format the content with metadata
  const content = `${chunk.speakerLabel}: ${chunk.text}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (graphitiKey) {
    headers["Authorization"] = `Bearer ${graphitiKey}`;
  }

  const response = await fetch(`${graphitiUrl}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      group_id: seriesData.id,
      messages: [
        {
          content,
          role_type: "user",
          role: chunk.speakerLabel,
          timestamp: new Date().toISOString(),
          source_description: `Podcast transcript chunk ${chunkIndex + 1}/${totalChunks} from "${episodeData.title}" (${seriesData.title}). Time: ${formatTimestamp(chunk.startTime)} - ${formatTimestamp(chunk.endTime)}. Context: ${context}`,
          metadata: {
            series_id: seriesData.id,
            series_title: seriesData.title,
            episode_id: episodeData.id,
            episode_title: episodeData.title,
            speaker_label: chunk.speakerLabel,
            start_time: chunk.startTime,
            end_time: chunk.endTime,
            chunk_index: chunkIndex,
            total_chunks: totalChunks,
            context_summary: context,
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Graphiti ingestion failed: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  return result.episode_id || result.id || `chunk-${chunkIndex}`;
}

/**
 * Update episode with graphiti episode IDs and final status
 */
async function updateEpisodeComplete(
  episodeId: string,
  graphitiEpisodeIds: string[]
): Promise<void> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  await fetch(`${apiUrl}/api/v1/episodes/${episodeId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      graphitiEpisodeIds,
      processingStatus: "complete",
    }),
  });
}

/**
 * Update episode with error status
 */
async function updateEpisodeError(
  episodeId: string,
  error: string
): Promise<void> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  await fetch(`${apiUrl}/api/v1/episodes/${episodeId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      processingStatus: "failed",
      processingError: error,
    }),
  });
}

/**
 * Ingest Transcript Lambda
 *
 * Consumes from transcript-ingest-queue
 * Fetches transcript from S3
 * Chunks by speaker with contextual summaries
 * Posts each chunk to Graphiti API
 */
export const main: SQSHandler = async (event: SQSEvent) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  const bucketName = process.env.MEDIA_BUCKET_NAME;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!bucketName) {
    throw new Error("MEDIA_BUCKET_NAME must be set");
  }

  const openai = new OpenAI({ apiKey: openaiKey });

  for (const record of event.Records) {
    const message: TranscriptIngestMessage = JSON.parse(record.body);
    const { episodeId } = message;
    console.log(`Processing transcript ingestion for episode: ${episodeId}`);

    try {
      // 1. Fetch episode and series data
      const episode = await fetchEpisode(episodeId);
      if (!episode) {
        console.error(`Episode not found: ${episodeId}`);
        continue;
      }

      const series = await fetchSeries(episode.seriesId);
      if (!series) {
        console.error(`Series not found: ${episode.seriesId}`);
        continue;
      }

      if (!episode.audioMediaId) {
        console.error(`Episode ${episodeId} has no audio media ID`);
        await updateEpisodeError(episodeId, "No audio media ID");
        continue;
      }

      // 2. Fetch transcript from S3
      console.log(`Fetching transcript for media: ${episode.audioMediaId}`);
      const transcript = await fetchTranscript(bucketName, episode.audioMediaId);
      const segments = transcript.results.audio_segments;
      console.log(`Found ${segments.length} transcript segments`);

      // 3. Chunk by speaker
      const chunks = chunkBySpeaker(segments);
      console.log(`Created ${chunks.length} chunks`);

      // 4. Process each chunk
      const graphitiEpisodeIds: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(
          `Processing chunk ${i + 1}/${chunks.length} (${chunk.speakerLabel}, ${chunk.lines.length} lines)`
        );

        // Generate contextual summary
        const context = await generateChunkContext(
          openai,
          series.title,
          episode.title,
          chunk.speakerLabel,
          chunk.text
        );

        // Ingest to Graphiti
        const graphitiId = await ingestChunkToGraphiti(
          chunk,
          context,
          series,
          episode,
          i,
          chunks.length
        );
        graphitiEpisodeIds.push(graphitiId);

        // Small delay to avoid rate limiting
        if (i < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      // 5. Update episode with graphiti IDs and complete status
      await updateEpisodeComplete(episodeId, graphitiEpisodeIds);

      console.log(
        `Successfully ingested ${chunks.length} chunks for episode: ${episodeId}`
      );
    } catch (error) {
      console.error(`Error ingesting transcript for episode ${episodeId}:`, error);

      await updateEpisodeError(
        episodeId,
        `Transcript ingestion error: ${error instanceof Error ? error.message : "Unknown error"}`
      );

      throw error;
    }
  }
};
