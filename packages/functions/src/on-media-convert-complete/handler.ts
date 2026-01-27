import type { EventBridgeEvent, Handler } from "aws-lambda";

interface MediaConvertJobStateChange {
  jobId: string;
  status: string;
  outputGroupDetails?: Array<{
    outputDetails: Array<{
      outputFilePaths: string[];
    }>;
  }>;
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

  const { jobId, status } = event.detail;
  console.log(`MediaConvert job ${jobId} completed with status: ${status}`);

  // TODO: Implement completion handler
  // 1. Look up episode by mediaConvertJobId
  // 2. If status is COMPLETE:
  //    - Update episode metadata if needed
  // 3. If status is ERROR:
  //    - Set episode.processingStatus = 'failed'
  //    - Set episode.processingError with details
};
