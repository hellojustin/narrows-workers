import type { SQSEvent, SQSHandler } from "aws-lambda";

/**
 * Download Audio Lambda
 *
 * Consumes from audio-download-queue
 * Downloads audio from enclosureUrl to S3
 * Creates Media record and updates Episode
 * Enqueues to processing-queue
 */
export const main: SQSHandler = async (event: SQSEvent) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    const { episodeId } = JSON.parse(record.body);
    console.log(`Processing audio download for episode: ${episodeId}`);

    // TODO: Implement audio download
    // 1. Fetch episode from database
    // 2. Create Media record with metadata from RSS enclosure
    // 3. Download audio from enclosureUrl to s3://<MEDIA_BUCKET>/raw/<media_id>
    // 4. Update Media record with file size, etc.
    // 5. Set episode.audioMediaId and processingStatus = 'downloading'
    // 6. Enqueue to processing-queue
  }
};
