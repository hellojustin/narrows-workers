/**
 * Lambda function definitions for the ingestion pipeline
 */

import { mediaBucketName } from "./storage";
import {
  rssRefreshQueue,
  audioDownloadQueue,
  processingQueue,
  transcriptIngestQueue,
} from "./queues";

// Common environment variables for all functions
const commonEnv = {
  MEDIA_BUCKET_NAME: mediaBucketName,
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  NARROWS_API_URL: process.env.NARROWS_API_URL ?? "",
  NARROWS_API_KEY: process.env.NARROWS_API_KEY ?? "",
};

// Fetch RSS - fetches and parses RSS feeds, creates/updates episodes
rssRefreshQueue.subscribe({
  handler: "packages/functions/src/fetch-rss/handler.main",
  runtime: "nodejs20.x",
  timeout: "2 minutes",
  memory: "512 MB",
  environment: {
    ...commonEnv,
    AUDIO_DOWNLOAD_QUEUE_URL: audioDownloadQueue.url,
  },
  link: [audioDownloadQueue],
});

// Download Audio - downloads audio files to S3
audioDownloadQueue.subscribe({
  handler: "packages/functions/src/download-audio/handler.main",
  runtime: "nodejs20.x",
  timeout: "10 minutes",
  memory: "1024 MB",
  permissions: [
    {
      actions: ["s3:PutObject", "s3:GetObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
  ],
  environment: {
    ...commonEnv,
    PROCESSING_QUEUE_URL: processingQueue.url,
  },
  link: [processingQueue],
});

// Start Processing - initiates both MediaConvert and Transcribe in parallel
processingQueue.subscribe({
  handler: "packages/functions/src/start-processing/handler.main",
  runtime: "nodejs20.x",
  timeout: "2 minutes",
  memory: "512 MB",
  permissions: [
    {
      actions: ["mediaconvert:CreateJob", "mediaconvert:DescribeEndpoints"],
      resources: ["*"],
    },
    {
      actions: ["iam:PassRole"],
      resources: [process.env.MEDIACONVERT_ROLE_ARN ?? "*"],
    },
    {
      actions: [
        "transcribe:StartTranscriptionJob",
        "transcribe:GetTranscriptionJob",
      ],
      resources: ["*"],
    },
    {
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
  ],
  environment: {
    ...commonEnv,
    MEDIACONVERT_ENDPOINT: process.env.MEDIACONVERT_ENDPOINT ?? "",
    MEDIACONVERT_ROLE_ARN: process.env.MEDIACONVERT_ROLE_ARN ?? "",
  },
});

// Ingest Transcript - chunks and sends to Graphiti
transcriptIngestQueue.subscribe({
  handler: "packages/functions/src/ingest-transcript/handler.main",
  runtime: "nodejs20.x",
  timeout: "10 minutes",
  memory: "1024 MB",
  permissions: [
    {
      actions: ["s3:GetObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
  ],
  environment: {
    ...commonEnv,
    GRAPHITI_API_URL: process.env.GRAPHITI_API_URL ?? "",
    GRAPHITI_API_KEY: process.env.GRAPHITI_API_KEY ?? "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  },
});

// On MediaConvert Complete - handles MediaConvert completion events
// This function is triggered by EventBridge (configured separately)
export const onMediaConvertComplete = new sst.aws.Function("OnMediaConvertComplete", {
  handler: "packages/functions/src/on-media-convert-complete/handler.main",
  runtime: "nodejs20.x",
  timeout: "1 minute",
  memory: "256 MB",
  environment: commonEnv,
});

// On Transcribe Complete - handles Transcribe completion events
// This function is triggered by EventBridge (configured separately)
export const onTranscribeComplete = new sst.aws.Function("OnTranscribeComplete", {
  handler: "packages/functions/src/on-transcribe-complete/handler.main",
  runtime: "nodejs20.x",
  timeout: "1 minute",
  memory: "256 MB",
  environment: {
    ...commonEnv,
    TRANSCRIPT_INGEST_QUEUE_URL: transcriptIngestQueue.url,
  },
  link: [transcriptIngestQueue],
  permissions: [
    {
      actions: ["sqs:SendMessage"],
      resources: [transcriptIngestQueue.arn],
    },
  ],
});

// Export the Lambda ARNs for EventBridge rule setup
export const lambdaArns = {
  onMediaConvertComplete: onMediaConvertComplete.arn,
  onTranscribeComplete: onTranscribeComplete.arn,
};
