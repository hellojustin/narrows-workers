/**
 * On Transcription Webhook Lambda
 *
 * Receives AssemblyAI webhook POSTs when transcription completes or errors.
 * Exposed as a public Function URL (no IAM auth) so AssemblyAI can call it.
 *
 * Flow:
 *   1. Parse AssemblyAI webhook payload: { transcript_id, status }
 *   2. Extract episodeId + audioMediaId from query string params
 *   3. On error: mark episode failed
 *   4. On completed: fetch full transcript + sentences, adapt to our format,
 *      write transcript.json to S3, enqueue for process-transcript pipeline
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { completeTranscription, updateEpisode } from "./complete-transcription";
import type { WebhookPayload } from "./types";

export const main = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  console.log("Received AssemblyAI webhook:", JSON.stringify(event, null, 2));

  const bucketName = process.env.MEDIA_BUCKET_NAME;
  const assemblyApiKey = process.env.ASSEMBLYAI_API_KEY;
  const transcriptIngestQueueUrl = process.env.TRANSCRIPT_INGEST_QUEUE_URL;

  if (!bucketName || !assemblyApiKey || !transcriptIngestQueueUrl) {
    console.error("Missing required environment variables");
    return { statusCode: 500, body: JSON.stringify({ error: "Server configuration error" }) };
  }

  // Parse query string parameters (episodeId and audioMediaId are embedded by start-processing)
  const params = event.queryStringParameters ?? {};
  const episodeId = params.episodeId;
  const audioMediaId = params.audioMediaId;

  if (!episodeId || !audioMediaId) {
    console.error("Missing episodeId or audioMediaId in query string", params);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing episodeId or audioMediaId" }),
    };
  }

  // Parse webhook payload
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(event.body ?? "{}") as WebhookPayload;
  } catch (err) {
    console.error("Failed to parse webhook body:", err);
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { transcript_id, status } = payload;
  console.log(`AssemblyAI transcript ${transcript_id} status: ${status} for episode ${episodeId}`);

  if (status === "error") {
    console.error(`AssemblyAI transcription failed for episode ${episodeId}`);
    await updateEpisode(episodeId, {
      processingStatus: "failed",
      processingError: "AssemblyAI transcription failed",
    });
    // Return 200 so AssemblyAI knows we received it (no retry needed for our failure)
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  if (status !== "completed") {
    // Ignore intermediate statuses (queued, processing)
    console.log(`Ignoring intermediate status: ${status}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  try {
    await completeTranscription({
      transcriptId: transcript_id,
      episodeId,
      audioMediaId,
      assemblyApiKey,
      bucketName,
      transcriptIngestQueueUrl,
    });

    console.log(`Successfully completed transcription for episode ${episodeId}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (error) {
    console.error(`Error completing transcription for episode ${episodeId}:`, error);

    await updateEpisode(episodeId, {
      processingStatus: "failed",
      processingError: `Transcription completion error: ${error instanceof Error ? error.message : "Unknown error"}`,
    });

    // Return 500 so AssemblyAI knows delivery failed (stale checker will recover)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal error processing transcription" }),
    };
  }
};
