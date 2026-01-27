import type { SQSEvent, SQSHandler } from "aws-lambda";

/**
 * Start MediaConvert Lambda
 *
 * Triggered by processing-queue
 * Creates AWS MediaConvert job for HLS conversion
 * Stores job ID in episode.mediaConvertJobId
 */
export const main: SQSHandler = async (event: SQSEvent) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    const { episodeId, audioMediaId } = JSON.parse(record.body);
    console.log(`Starting MediaConvert for episode: ${episodeId}`);

    // TODO: Implement MediaConvert job creation
    // 1. Create AWS MediaConvert job:
    //    - Input: s3://<MEDIA_BUCKET>/raw/<audio_media_id>
    //    - Output: s3://<MEDIA_BUCKET>/processed/<audio_media_id>/hls/
    // 2. Store job ID in episode.mediaConvertJobId
    // 3. Update episode.processingStatus = 'processing'
  }
};
