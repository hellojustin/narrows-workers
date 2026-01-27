import type { SQSEvent, SQSHandler } from "aws-lambda";
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
} from "@aws-sdk/client-transcribe";

const transcribeClient = new TranscribeClient({});

interface ProcessingMessage {
  episodeId: string;
  audioMediaId: string;
}

/**
 * Update episode with Transcribe job name
 */
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
 * Generate a unique job name for Transcribe
 */
function generateJobName(episodeId: string): string {
  const timestamp = Date.now();
  const shortId = episodeId.split("-")[0];
  return `narrows-${shortId}-${timestamp}`;
}

/**
 * Start Transcribe Lambda
 *
 * Triggered by processing-queue (parallel with MediaConvert)
 * Creates AWS Transcribe job with speaker diarization
 * Stores job name in episode.transcribeJobName
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
    console.log(`Starting Transcribe for episode: ${episodeId}, media: ${audioMediaId}`);

    try {
      const inputS3Uri = `s3://${bucketName}/raw/${audioMediaId}`;
      const outputS3Uri = `s3://${bucketName}/processed/${audioMediaId}/`;
      const jobName = generateJobName(episodeId);

      // Create Transcribe job with speaker diarization
      await transcribeClient.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: jobName,
          LanguageCode: "en-US",
          Media: {
            MediaFileUri: inputS3Uri,
          },
          OutputBucketName: bucketName,
          OutputKey: `processed/${audioMediaId}/transcript.json`,
          Settings: {
            ShowSpeakerLabels: true,
            MaxSpeakerLabels: 10,
            ShowAlternatives: false,
          },
          // Add job tags for tracking
          Tags: [
            { Key: "episodeId", Value: episodeId },
            { Key: "audioMediaId", Value: audioMediaId },
          ],
        })
      );

      console.log(`Created Transcribe job: ${jobName}`);

      // Update episode with job name and status
      await updateEpisode(episodeId, {
        transcribeJobName: jobName,
        processingStatus: "transcribing",
      });
    } catch (error) {
      console.error(`Error starting Transcribe for episode ${episodeId}:`, error);

      await updateEpisode(episodeId, {
        processingStatus: "failed",
        processingError: `Transcribe error: ${error instanceof Error ? error.message : "Unknown error"}`,
      });

      throw error;
    }
  }
};
