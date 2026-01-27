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
export const fetchRss = new sst.aws.Function("FetchRss", {
  name: `narrows-${$app.stage}-fetch-rss`,
  handler: "packages/functions/src/fetch-rss/handler.main",
  runtime: "nodejs20.x",
  timeout: "2 minutes",
  memory: "512 MB",
  environment: {
    ...commonEnv,
    AUDIO_DOWNLOAD_QUEUE_URL: audioDownloadQueue.url,
  },
});

// Subscribe to RSS refresh queue
rssRefreshQueue.subscribe(fetchRss.arn);

// Download Audio - downloads audio files to S3
export const downloadAudio = new sst.aws.Function("DownloadAudio", {
  name: `narrows-${$app.stage}-download-audio`,
  handler: "packages/functions/src/download-audio/handler.main",
  runtime: "nodejs20.x",
  timeout: "10 minutes", // Large files can take time
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
});

// Subscribe to audio download queue
audioDownloadQueue.subscribe(downloadAudio.arn);

// Start MediaConvert - initiates HLS conversion
export const startMediaConvert = new sst.aws.Function("StartMediaConvert", {
  name: `narrows-${$app.stage}-start-media-convert`,
  handler: "packages/functions/src/start-media-convert/handler.main",
  runtime: "nodejs20.x",
  timeout: "1 minute",
  memory: "256 MB",
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

// Start Transcribe - initiates transcription
export const startTranscribe = new sst.aws.Function("StartTranscribe", {
  name: `narrows-${$app.stage}-start-transcribe`,
  handler: "packages/functions/src/start-transcribe/handler.main",
  runtime: "nodejs20.x",
  timeout: "1 minute",
  memory: "256 MB",
  permissions: [
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
  environment: commonEnv,
});

// Subscribe both processing functions to processing queue
processingQueue.subscribe(startMediaConvert.arn);
processingQueue.subscribe(startTranscribe.arn);

// On MediaConvert Complete - handles MediaConvert completion events
export const onMediaConvertComplete = new sst.aws.Function("OnMediaConvertComplete", {
  name: `narrows-${$app.stage}-on-media-convert-complete`,
  handler: "packages/functions/src/on-media-convert-complete/handler.main",
  runtime: "nodejs20.x",
  timeout: "1 minute",
  memory: "256 MB",
  environment: commonEnv,
});

// On Transcribe Complete - handles Transcribe completion events
export const onTranscribeComplete = new sst.aws.Function("OnTranscribeComplete", {
  name: `narrows-${$app.stage}-on-transcribe-complete`,
  handler: "packages/functions/src/on-transcribe-complete/handler.main",
  runtime: "nodejs20.x",
  timeout: "1 minute",
  memory: "256 MB",
  environment: {
    ...commonEnv,
    TRANSCRIPT_INGEST_QUEUE_URL: transcriptIngestQueue.url,
  },
});

// Ingest Transcript - chunks and sends to Graphiti
export const ingestTranscript = new sst.aws.Function("IngestTranscript", {
  name: `narrows-${$app.stage}-ingest-transcript`,
  handler: "packages/functions/src/ingest-transcript/handler.main",
  runtime: "nodejs20.x",
  timeout: "10 minutes", // AI processing can take time
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

// Subscribe to transcript ingest queue
transcriptIngestQueue.subscribe(ingestTranscript.arn);

// EventBridge rules for completion events
// MediaConvert job state change rule
new sst.aws.Function("MediaConvertEventHandler", {
  name: `narrows-${$app.stage}-mediaconvert-event-handler`,
  handler: "packages/functions/src/on-media-convert-complete/handler.main",
  runtime: "nodejs20.x",
  timeout: "1 minute",
  memory: "256 MB",
  environment: commonEnv,
}).nodes.function.addEventSource(
  // This will be set up via CloudFormation/Terraform for default EventBridge bus
  // with pattern matching for MediaConvert job state changes
);

// Transcribe job state change rule  
new sst.aws.Function("TranscribeEventHandler", {
  name: `narrows-${$app.stage}-transcribe-event-handler`,
  handler: "packages/functions/src/on-transcribe-complete/handler.main",
  runtime: "nodejs20.x",
  timeout: "1 minute",
  memory: "256 MB",
  environment: {
    ...commonEnv,
    TRANSCRIPT_INGEST_QUEUE_URL: transcriptIngestQueue.url,
  },
}).nodes.function.addEventSource(
  // This will be set up via CloudFormation/Terraform for default EventBridge bus
  // with pattern matching for Transcribe job state changes
);
