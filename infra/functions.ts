/**
 * Lambda function definitions for the ingestion pipeline
 */

import { mediaBucketName } from "./storage";
import {
  rssRefreshQueue,
  audioDownloadQueue,
  imageDownloadQueue,
  imageProcessingQueue,
  processingQueue,
  transcriptIngestQueue,
} from "./queues";

// VPC configuration for Lambda functions
// Required for accessing internal services like Graphiti
const vpcConfig = process.env.VPC_SUBNET_IDS
  ? {
      securityGroups: (process.env.VPC_SECURITY_GROUP_IDS ?? "").split(",").filter(Boolean),
      privateSubnets: (process.env.VPC_SUBNET_IDS ?? "").split(",").filter(Boolean),
    }
  : undefined;

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
  permissions: [
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [rssRefreshQueue.arn],
    },
    {
      actions: ["sqs:SendMessage"],
      resources: [audioDownloadQueue.arn, imageDownloadQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    AUDIO_DOWNLOAD_QUEUE_URL: audioDownloadQueue.url,
    IMAGE_DOWNLOAD_QUEUE_URL: imageDownloadQueue.url,
  },
  link: [audioDownloadQueue, imageDownloadQueue],
});
rssRefreshQueue.subscribe(fetchRss.arn);

// Download Audio - downloads audio files to S3
export const downloadAudio = new sst.aws.Function("DownloadAudio", {
  name: `narrows-${$app.stage}-download-audio`,
  handler: "packages/functions/src/download-audio/handler.main",
  runtime: "nodejs20.x",
  timeout: "10 minutes",
  memory: "1024 MB",
  permissions: [
    {
      actions: ["s3:PutObject", "s3:GetObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [audioDownloadQueue.arn],
    },
    {
      actions: ["sqs:SendMessage"],
      resources: [processingQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    PROCESSING_QUEUE_URL: processingQueue.url,
  },
  link: [processingQueue],
});
audioDownloadQueue.subscribe(downloadAudio.arn);

// Download Image - downloads series/episode artwork to S3
export const downloadImage = new sst.aws.Function("DownloadImage", {
  name: `narrows-${$app.stage}-download-image`,
  handler: "packages/functions/src/download-image/handler.main",
  runtime: "nodejs20.x",
  timeout: "5 minutes",
  memory: "512 MB",
  permissions: [
    {
      actions: ["s3:PutObject", "s3:GetObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [imageDownloadQueue.arn],
    },
    {
      actions: ["sqs:SendMessage"],
      resources: [imageProcessingQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    IMAGE_PROCESSING_QUEUE_URL: imageProcessingQueue.url,
  },
  link: [imageProcessingQueue],
});
imageDownloadQueue.subscribe(downloadImage.arn);

// Process Image - converts images to base.png and base.jpg formats
// Uses sharp which requires platform-specific installation for Lambda
export const processImage = new sst.aws.Function("ProcessImage", {
  name: `narrows-${$app.stage}-process-image`,
  handler: "packages/functions/src/process-image/handler.main",
  runtime: "nodejs20.x",
  timeout: "5 minutes",
  memory: "1024 MB", // Image processing needs more memory
  permissions: [
    {
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [imageProcessingQueue.arn],
    },
  ],
  environment: commonEnv,
  nodejs: {
    install: ["sharp"], // Install sharp for Lambda (Linux) platform
  },
});
imageProcessingQueue.subscribe(processImage.arn);

// Start Processing - initiates both MediaConvert and Transcribe in parallel
export const startProcessing = new sst.aws.Function("StartProcessing", {
  name: `narrows-${$app.stage}-start-processing`,
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
        "transcribe:TagResource",
      ],
      resources: ["*"],
    },
    {
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [processingQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    MEDIACONVERT_ENDPOINT: process.env.MEDIACONVERT_ENDPOINT ?? "",
    MEDIACONVERT_ROLE_ARN: process.env.MEDIACONVERT_ROLE_ARN ?? "",
  },
});
processingQueue.subscribe(startProcessing.arn);

// Ingest Transcript - chunks and sends to Graphiti
// Runs in VPC to access internal Graphiti service
export const ingestTranscript = new sst.aws.Function("IngestTranscript", {
  name: `narrows-${$app.stage}-ingest-transcript`,
  handler: "packages/functions/src/ingest-transcript/handler.main",
  runtime: "nodejs20.x",
  timeout: "10 minutes",
  memory: "1024 MB",
  vpc: vpcConfig,
  permissions: [
    {
      actions: ["s3:GetObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [transcriptIngestQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    GRAPHITI_API_URL: process.env.GRAPHITI_API_URL ?? "",
    GRAPHITI_API_KEY: process.env.GRAPHITI_API_KEY ?? "",
    GRAPHITI_GRAPH_ID: process.env.GRAPHITI_GRAPH_ID ?? "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  },
});
transcriptIngestQueue.subscribe(ingestTranscript.arn);

// On MediaConvert Complete - handles MediaConvert completion events
export const onMediaConvertComplete = new sst.aws.Function("OnMediaConvertComplete", {
  name: `narrows-${$app.stage}-on-mediaconvert-complete`,
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
  link: [transcriptIngestQueue],
  permissions: [
    {
      actions: ["sqs:SendMessage"],
      resources: [transcriptIngestQueue.arn],
    },
  ],
});

// Resize Image - on-demand image resizing for CloudFront
// This Lambda provides a Function URL that CloudFront can call for /image/* requests
// Uses sharp which requires platform-specific installation for Lambda
export const resizeImage = new sst.aws.Function("ResizeImage", {
  name: `narrows-${$app.stage}-resize-image`,
  handler: "packages/functions/src/resize-image/handler.main",
  runtime: "nodejs20.x",
  timeout: "30 seconds",
  memory: "1024 MB", // Image processing needs memory
  url: {
    authorization: "none", // Public access for CloudFront (no IAM auth required)
  },
  permissions: [
    {
      actions: ["s3:GetObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
  ],
  environment: commonEnv,
  nodejs: {
    install: ["sharp"], // Install sharp for Lambda (Linux) platform
  },
});

// Export the Lambda ARNs for EventBridge rule setup
export const lambdaArns = {
  onMediaConvertComplete: onMediaConvertComplete.arn,
  onTranscribeComplete: onTranscribeComplete.arn,
};
