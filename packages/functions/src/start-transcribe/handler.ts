import type { SQSEvent, SQSHandler } from "aws-lambda";

/**
 * Start Transcribe Lambda
 *
 * Triggered by processing-queue (parallel with MediaConvert)
 * Creates AWS Transcribe job with speaker diarization
 * Stores job name in episode.transcribeJobName
 */
export const main: SQSHandler = async (event: SQSEvent) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    const { episodeId, audioMediaId } = JSON.parse(record.body);
    console.log(`Starting Transcribe for episode: ${episodeId}`);

    // TODO: Implement Transcribe job creation
    // 1. Create AWS Transcribe job:
    //    - Input: s3://<MEDIA_BUCKET>/raw/<audio_media_id>
    //    - Output: s3://<MEDIA_BUCKET>/processed/<audio_media_id>/transcript.json
    //    - Settings: speaker diarization enabled
    // 2. Store job name in episode.transcribeJobName
    // 3. Update episode.processingStatus = 'transcribing'
  }
};
