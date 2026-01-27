import type { EventBridgeEvent, Handler } from "aws-lambda";

interface MediaConvertJobStateChange {
  jobId: string;
  status: "SUBMITTED" | "PROGRESSING" | "COMPLETE" | "CANCELED" | "ERROR";
  userMetadata?: {
    episodeId?: string;
    audioMediaId?: string;
  };
  errorCode?: number;
  errorMessage?: string;
  outputGroupDetails?: Array<{
    outputDetails: Array<{
      outputFilePaths: string[];
    }>;
  }>;
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
 * Find episode by MediaConvert job ID
 */
async function findEpisodeByJobId(jobId: string): Promise<string | null> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  const response = await fetch(
    `${apiUrl}/api/v1/episodes?mediaConvertJobId=${encodeURIComponent(jobId)}`,
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
 * On MediaConvert Complete Lambda
 *
 * Event-driven - triggered by EventBridge when MediaConvert job finishes
 * Updates episode status based on job result
 */
export const main: Handler<EventBridgeEvent<"MediaConvert Job State Change", MediaConvertJobStateChange>> = async (
  event
) => {
  console.log("Received MediaConvert event:", JSON.stringify(event, null, 2));

  const { jobId, status, userMetadata, errorCode, errorMessage } = event.detail;
  console.log(`MediaConvert job ${jobId} completed with status: ${status}`);

  // Try to get episode ID from user metadata first, then search by job ID
  let episodeId = userMetadata?.episodeId;
  if (!episodeId) {
    episodeId = await findEpisodeByJobId(jobId) || undefined;
  }

  if (!episodeId) {
    console.error(`Could not find episode for MediaConvert job: ${jobId}`);
    return;
  }

  if (status === "COMPLETE") {
    console.log(`MediaConvert job ${jobId} completed successfully`);
    // Note: We don't change processingStatus here because Transcribe
    // might still be running. The final status is set when Transcribe completes.
  } else if (status === "ERROR" || status === "CANCELED") {
    console.error(`MediaConvert job ${jobId} failed: ${errorMessage}`);
    await updateEpisode(episodeId, {
      processingStatus: "failed",
      processingError: `MediaConvert ${status}: ${errorMessage || "Unknown error"} (code: ${errorCode})`,
    });
  }
  // Ignore SUBMITTED and PROGRESSING statuses
};
