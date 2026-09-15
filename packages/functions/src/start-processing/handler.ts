import type { SQSEvent, SQSHandler } from "aws-lambda";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { isEpisodeIngestible } from "../shared/episode-guard";

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

interface ProcessingMessage {
  episodeId: string;
  audioMediaId: string;
}

async function updateEpisode(
  episodeId: string,
  updates: {
    transcribeJobName?: string;
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
 * Submit audio to AssemblyAI for transcription with speaker diarization.
 *
 * Generates a presigned S3 URL so AssemblyAI can fetch the audio directly
 * without requiring the bucket to be public. Returns the AssemblyAI transcript
 * ID which is stored on the episode as transcribeJobName for lookup later.
 */
async function startAssemblyAITranscription(
  episodeId: string,
  audioMediaId: string,
  bucketName: string
): Promise<string> {
  const presignedUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: bucketName,
      Key: `raw/${audioMediaId}`,
    }),
    { expiresIn: 3600 }
  );

  const webhookBaseUrl = process.env.ASSEMBLYAI_WEBHOOK_URL;
  const webhookUrl = `${webhookBaseUrl}?episodeId=${encodeURIComponent(episodeId)}&audioMediaId=${encodeURIComponent(audioMediaId)}`;

  const response = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      Authorization: process.env.ASSEMBLYAI_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio_url: presignedUrl,
      speech_models: ["universal-2"],
      speaker_labels: true,
      webhook_url: webhookUrl,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AssemblyAI submission failed: ${response.status} - ${errorText}`);
  }

  const result = (await response.json()) as { id: string };
  return result.id;
}

async function enqueueFfmpegTranscode(episodeId: string, audioMediaId: string): Promise<void> {
  const queueUrl = process.env.AUDIO_TRANSCODE_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("AUDIO_TRANSCODE_QUEUE_URL must be set");
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ episodeId, audioMediaId }),
    })
  );
}

/**
 * Enqueue waveform and per-frequency-band analysis.
 *
 * Separate from the transcode, and deliberately not fatal: waveform data is
 * additive, so failing to enqueue it must not fail an otherwise fine episode.
 */
async function enqueueAudioAnalysis(episodeId: string, audioMediaId: string): Promise<void> {
  const queueUrl = process.env.AUDIO_ANALYSIS_QUEUE_URL;
  if (!queueUrl) return;

  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ episodeId, audioMediaId }),
      })
    );
  } catch (error) {
    console.error(`Failed to enqueue audio analysis for ${audioMediaId}:`, error);
  }
}

/**
 * Start Processing Lambda
 *
 * Triggered by processing-queue.
 * Starts AssemblyAI transcription and the ffmpeg HLS transcode in parallel.
 */
export const main: SQSHandler = async (event: SQSEvent) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  const bucketName = process.env.MEDIA_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("MEDIA_BUCKET_NAME must be set");
  }

  for (const record of event.Records) {
    const message: ProcessingMessage = JSON.parse(record.body);
    const { episodeId, audioMediaId } = message;
    console.log(`Starting processing for episode: ${episodeId}, media: ${audioMediaId}`);

    try {
      if (!(await isEpisodeIngestible(episodeId))) {
        console.log(
          `Skipping processing for episode ${episodeId}: not found or series opted out`
        );
        continue;
      }

      const [transcribeJobName] = await Promise.all([
        startAssemblyAITranscription(episodeId, audioMediaId, bucketName),
        enqueueFfmpegTranscode(episodeId, audioMediaId),
      ]);

      console.log(`Enqueued ffmpeg transcode for media ${audioMediaId}`);
      console.log(`Started AssemblyAI transcription: ${transcribeJobName}`);

      await enqueueAudioAnalysis(episodeId, audioMediaId);

      await updateEpisode(episodeId, {
        transcribeJobName,
        processingStatus: "processing",
      });
    } catch (error) {
      console.error(`Error starting processing for episode ${episodeId}:`, error);

      await updateEpisode(episodeId, {
        processingStatus: "failed",
        processingError: `Processing error: ${error instanceof Error ? error.message : "Unknown error"}`,
      });

      throw error;
    }
  }
};
