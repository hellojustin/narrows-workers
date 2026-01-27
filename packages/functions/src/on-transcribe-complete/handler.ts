import type { EventBridgeEvent, Handler } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqsClient = new SQSClient({});

interface TranscribeJobStateChange {
  TranscriptionJobName: string;
  TranscriptionJobStatus: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  FailureReason?: string;
}

/**
 * Update episode status
 */
async function updateEpisode(
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
 * Find episode by Transcribe job name
 */
async function findEpisodeByJobName(jobName: string): Promise<string | null> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  const response = await fetch(
    `${apiUrl}/api/v1/episodes?transcribeJobName=${encodeURIComponent(jobName)}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );

  if (!response.ok) {
    console.error(`Failed to search episodes: ${response.statusText}`);
    return null;
  }

  const { data } = await response.json();
  return data?.[0]?.id || null;
}

/**
 * Enqueue episode for transcript ingestion
 */
async function enqueueTranscriptIngestion(episodeId: string): Promise<void> {
  const queueUrl = process.env.TRANSCRIPT_INGEST_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("TRANSCRIPT_INGEST_QUEUE_URL must be set");
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ episodeId }),
    })
  );
}

/**
 * On Transcribe Complete Lambda
 *
 * Event-driven - triggered by EventBridge when Transcribe job finishes
 * Updates episode status and enqueues to transcript-ingest-queue
 */
export const main: Handler<EventBridgeEvent<"Transcribe Job State Change", TranscribeJobStateChange>> = async (
  event
) => {
  console.log("Received Transcribe event:", JSON.stringify(event, null, 2));

  const { TranscriptionJobName, TranscriptionJobStatus, FailureReason } = event.detail;
  console.log(`Transcribe job ${TranscriptionJobName} completed with status: ${TranscriptionJobStatus}`);

  // Find episode by job name
  const episodeId = await findEpisodeByJobName(TranscriptionJobName);
  if (!episodeId) {
    console.error(`Could not find episode for Transcribe job: ${TranscriptionJobName}`);
    return;
  }

  if (TranscriptionJobStatus === "COMPLETED") {
    console.log(`Transcribe job ${TranscriptionJobName} completed successfully`);

    // Update status to ingesting
    await updateEpisode(episodeId, {
      processingStatus: "ingesting",
    });

    // Enqueue for transcript ingestion
    await enqueueTranscriptIngestion(episodeId);
    console.log(`Enqueued episode ${episodeId} for transcript ingestion`);
  } else if (TranscriptionJobStatus === "FAILED") {
    console.error(`Transcribe job ${TranscriptionJobName} failed: ${FailureReason}`);
    await updateEpisode(episodeId, {
      processingStatus: "failed",
      processingError: `Transcribe failed: ${FailureReason || "Unknown error"}`,
    });
  }
  // Ignore IN_PROGRESS status
};
