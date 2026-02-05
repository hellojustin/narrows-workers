/**
 * Process Transcript Lambda Handler
 *
 * Orchestrates the transcript processing pipeline:
 * 1. Identify speakers using LLM
 * 2. Identify chapters using LLM
 * 3. Identify segments using LLM
 * 4. Ingest segments to Graphiti
 */

import type { SQSEvent, SQSHandler } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import OpenAI from 'openai';

import type {
  TranscriptProcessMessage,
  TranscriptResult,
  TranscriptSegment,
} from './types';
import {
  fetchEpisode,
  fetchSeries,
  updateEpisodeSpeakers,
  upsertChapter,
  upsertSegment,
  updateEpisodeComplete,
  updateEpisodeError,
} from './api-client';
import { identifySpeakers } from './identify-speakers';
import { identifyChapters } from './identify-chapters';
import { identifySegments } from './identify-segments';
import { ingestSegmentsToGraphiti } from './ingest-to-graphiti';

const s3Client = new S3Client({});

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
    throw new Error('Empty transcript file');
  }

  return JSON.parse(body) as TranscriptResult;
}

/**
 * Main handler for processing transcripts
 */
export const main: SQSHandler = async (event: SQSEvent) => {
  console.log('Received event:', JSON.stringify(event, null, 2));

  const bucketName = process.env.MEDIA_BUCKET_NAME;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!bucketName) {
    throw new Error('MEDIA_BUCKET_NAME must be set');
  }

  const openai = new OpenAI({ apiKey: openaiKey });

  for (const record of event.Records) {
    const message: TranscriptProcessMessage = JSON.parse(record.body);
    const { episodeId } = message;
    console.log(`Processing transcript for episode: ${episodeId}`);

    try {
      // 1. Fetch episode and series data
      console.log('Fetching episode data...');
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
        await updateEpisodeError(episodeId, 'No audio media ID');
        continue;
      }

      // 2. Fetch transcript from S3
      console.log(`Fetching transcript for media: ${episode.audioMediaId}`);
      const transcript = await fetchTranscript(bucketName, episode.audioMediaId);
      const segments = transcript.results.audio_segments;
      console.log(`Found ${segments.length} transcript segments`);

      // 3. Identify speakers
      console.log('Identifying speakers...');
      const speakerData = await identifySpeakers(openai, series, episode, segments);
      console.log(
        `Identified ${Object.keys(speakerData).length} speakers:`,
        JSON.stringify(speakerData, null, 2)
      );

      // Save speaker data to episode
      await updateEpisodeSpeakers(episodeId, speakerData);

      // 4. Identify chapters
      console.log('Identifying chapters...');
      const chapters = await identifyChapters(
        openai,
        series,
        episode,
        segments,
        speakerData
      );
      console.log(`Identified ${chapters.length} chapters`);

      // Save chapters to API
      for (const chapter of chapters) {
        await upsertChapter(chapter);
        console.log(`Saved chapter: ${chapter.title} (${chapter.type})`);
      }

      // 5. Identify segments
      console.log('Identifying segments...');
      const identifiedSegments = await identifySegments(
        openai,
        series,
        episode,
        segments,
        speakerData,
        chapters
      );
      console.log(`Identified ${identifiedSegments.length} segments`);

      // Save segments to API
      for (const segment of identifiedSegments) {
        await upsertSegment(segment);
      }
      console.log(`Saved ${identifiedSegments.length} segments`);

      // 6. Ingest segments to Graphiti
      console.log('Ingesting segments to Graphiti...');
      const graphitiIds = await ingestSegmentsToGraphiti(
        openai,
        identifiedSegments,
        series,
        episode,
        speakerData,
        segments // Pass raw transcript segments for structured data
      );
      console.log(`Ingested ${graphitiIds.length} items to Graphiti`);

      // 7. Update episode with complete status
      await updateEpisodeComplete(episodeId, graphitiIds);

      console.log(`Successfully processed transcript for episode: ${episodeId}`);
      console.log(
        `Summary: ${Object.keys(speakerData).length} speakers, ${chapters.length} chapters, ${identifiedSegments.length} segments, ${graphitiIds.length} Graphiti items`
      );
    } catch (error) {
      console.error(`Error processing transcript for episode ${episodeId}:`, error);

      await updateEpisodeError(
        episodeId,
        `Transcript processing error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );

      throw error;
    }
  }
};
