/**
 * Shared logic for completing a transcription: fetch from AssemblyAI,
 * adapt to our format, write to S3, and enqueue for processing.
 *
 * Called by both the webhook handler (happy path) and the stale job checker
 * (recovery path for missed webhooks).
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { adaptToTranscriptResult } from "./adapter";
import type { AssemblyAITranscript, AssemblyAISentencesResponse } from "./types";

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

/**
 * Fetch the full transcript from AssemblyAI.
 */
export async function fetchAssemblyAITranscript(
  transcriptId: string,
  apiKey: string
): Promise<AssemblyAITranscript> {
  const response = await fetch(
    `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
    {
      headers: { Authorization: apiKey },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `AssemblyAI transcript fetch failed: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<AssemblyAITranscript>;
}

/**
 * Fetch the sentences split from AssemblyAI. Sentences have speaker labels
 * and timestamps and are used as audio_segments in the adapted output.
 */
export async function fetchAssemblyAISentences(
  transcriptId: string,
  apiKey: string
): Promise<AssemblyAISentencesResponse> {
  const response = await fetch(
    `https://api.assemblyai.com/v2/transcript/${transcriptId}/sentences`,
    {
      headers: { Authorization: apiKey },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `AssemblyAI sentences fetch failed: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<AssemblyAISentencesResponse>;
}

/**
 * Update episode status via the Narrows API.
 */
export async function updateEpisode(
  episodeId: string,
  updates: {
    processingStatus?: string;
    processingError?: string;
  }
): Promise<void> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  await fetch(`${apiUrl}/api/v1/episodes/${episodeId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updates),
  });
}

/**
 * Fetch transcript + sentences from AssemblyAI, adapt to our format,
 * write transcript.json to S3, and enqueue the episode for processing.
 */
export async function completeTranscription(params: {
  transcriptId: string;
  episodeId: string;
  audioMediaId: string;
  assemblyApiKey: string;
  bucketName: string;
  transcriptIngestQueueUrl: string;
}): Promise<void> {
  const {
    transcriptId,
    episodeId,
    audioMediaId,
    assemblyApiKey,
    bucketName,
    transcriptIngestQueueUrl,
  } = params;

  // Fetch full transcript and sentences in parallel
  const [transcript, sentencesResponse] = await Promise.all([
    fetchAssemblyAITranscript(transcriptId, assemblyApiKey),
    fetchAssemblyAISentences(transcriptId, assemblyApiKey),
  ]);

  // Adapt to existing format
  const adapted = adaptToTranscriptResult(
    transcript.words ?? [],
    sentencesResponse.sentences ?? []
  );

  // Write to S3 at the expected path
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: `processed/${audioMediaId}/transcript.json`,
      Body: JSON.stringify(adapted),
      ContentType: "application/json",
    })
  );

  console.log(
    `Wrote transcript.json for ${audioMediaId}: ` +
      `${adapted.results.audio_segments.length} segments, ` +
      `${adapted.results.items.length} items`
  );

  // Enqueue for transcript ingestion pipeline
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: transcriptIngestQueueUrl,
      MessageBody: JSON.stringify({ episodeId }),
    })
  );

  // Mark episode as ingesting
  await updateEpisode(episodeId, { processingStatus: "ingesting" });
}
