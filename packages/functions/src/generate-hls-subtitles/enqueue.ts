/**
 * Shared helper to enqueue subtitle generation when pipeline prerequisites exist.
 */

import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { masterManifestKey, transcriptJsonKey } from "./paths";

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

export async function enqueueSubtitleGeneration(params: {
  episodeId: string;
  audioMediaId: string;
  bucketName: string;
  queueUrl: string;
}): Promise<boolean> {
  const { episodeId, audioMediaId, bucketName, queueUrl } = params;

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ episodeId, audioMediaId }),
    })
  );

  console.log(`Enqueued subtitle generation for episode ${episodeId}, media ${audioMediaId}`);
  return true;
}

/**
 * After transcription completes: enqueue if HLS master manifest exists.
 */
export async function tryEnqueueAfterTranscription(params: {
  episodeId: string;
  audioMediaId: string;
  bucketName: string;
  queueUrl: string;
}): Promise<void> {
  const manifestExists = await objectExists(
    params.bucketName,
    masterManifestKey(params.audioMediaId)
  );

  if (!manifestExists) {
    console.log(
      `HLS manifest not ready for ${params.audioMediaId}; MediaConvert handler will enqueue`
    );
    return;
  }

  await enqueueSubtitleGeneration(params);
}

/**
 * After MediaConvert completes: enqueue if transcript.json exists.
 */
export async function tryEnqueueAfterMediaConvert(params: {
  episodeId: string;
  audioMediaId: string;
  bucketName: string;
  queueUrl: string;
}): Promise<void> {
  const transcriptExists = await objectExists(
    params.bucketName,
    transcriptJsonKey(params.audioMediaId)
  );

  if (!transcriptExists) {
    console.log(
      `Transcript not ready for ${params.audioMediaId}; transcription handler will enqueue`
    );
    return;
  }

  await enqueueSubtitleGeneration(params);
}
