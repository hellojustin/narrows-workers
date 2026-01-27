import type { EventBridgeEvent, Handler } from "aws-lambda";

interface TranscribeJobStateChange {
  TranscriptionJobName: string;
  TranscriptionJobStatus: string;
  FailureReason?: string;
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

  // TODO: Implement completion handler
  // 1. Look up episode by transcribeJobName
  // 2. If status is COMPLETED:
  //    - Enqueue episode ID to transcript-ingest-queue
  // 3. If status is FAILED:
  //    - Set episode.processingStatus = 'failed'
  //    - Set episode.processingError = FailureReason
};
