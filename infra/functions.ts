/**
 * Lambda function definitions for the ingestion pipeline.
 * All functions have reserved concurrency of 1 to prevent thundering herd.
 */

import { mediaBucketName } from "./storage";
import {
  rssRefreshQueue,
  audioDownloadQueue,
  imageDownloadQueue,
  imageProcessingQueue,
  processingQueue,
  transcriptIngestQueue,
  listeningEventsQueue,
  discoveryQueue,
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

// Fetch RSS - fetches and parses RSS feeds, batch-syncs episodes
export const fetchRss = new sst.aws.Function("FetchRss", {
  name: `narrows-${$app.stage}-fetch-rss`,
  handler: "packages/functions/src/fetch-rss/handler.main",
  runtime: "nodejs20.x",
  timeout: "2 minutes",
  memory: "512 MB",
  concurrency: { reserved: 1 },
  permissions: [
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [rssRefreshQueue.arn],
    },
    {
      actions: ["sqs:SendMessage", "sqs:SendMessageBatch"],
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
  concurrency: { reserved: 1 },
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
  concurrency: { reserved: 1 },
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
  memory: "1024 MB",
  concurrency: { reserved: 3 },
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
    install: ["sharp", "node-vibrant"],
  },
});
imageProcessingQueue.subscribe(processImage.arn);

// On Transcription Webhook - receives AssemblyAI webhook, adapts transcript, writes to S3
// Must be declared before startProcessing so its .url is available for SST linking
export const onTranscriptionWebhook = new sst.aws.Function("OnTranscriptionWebhook", {
  name: `narrows-${$app.stage}-on-transcription-webhook`,
  handler: "packages/functions/src/on-transcription-webhook/handler.main",
  runtime: "nodejs20.x",
  timeout: "2 minutes",
  memory: "512 MB",
  concurrency: { reserved: 1 },
  url: {
    authorization: "none",
  },
  permissions: [
    {
      actions: ["s3:PutObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
    {
      actions: ["sqs:SendMessage"],
      resources: [transcriptIngestQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "",
    TRANSCRIPT_INGEST_QUEUE_URL: transcriptIngestQueue.url,
  },
  link: [transcriptIngestQueue],
});

// SST v3 doesn't add lambda:InvokeFunction for public function URLs (fixed in v4.2.6).
// Without this, AWS returns 403 on accounts with the public access block enabled.
new aws.lambda.Permission("OnTranscriptionWebhookPublicInvoke", {
  function: `narrows-${$app.stage}-on-transcription-webhook`,
  action: "lambda:InvokeFunction",
  principal: "*",
  statementId: "FunctionURLInvokeAllowPublicAccess",
});

// Check Stale Transcriptions - polls AssemblyAI for episodes stuck in processing
// Recovers episodes where the webhook was missed or our handler failed
export const checkStaleTranscriptions = new sst.aws.Function("CheckStaleTranscriptions", {
  name: `narrows-${$app.stage}-check-stale-transcriptions`,
  handler: "packages/functions/src/check-stale-transcriptions/handler.main",
  runtime: "nodejs20.x",
  timeout: "5 minutes",
  memory: "512 MB",
  concurrency: { reserved: 1 },
  permissions: [
    {
      actions: ["s3:PutObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
    {
      actions: ["sqs:SendMessage"],
      resources: [transcriptIngestQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "",
    TRANSCRIPT_INGEST_QUEUE_URL: transcriptIngestQueue.url,
  },
  link: [transcriptIngestQueue],
});

// Start Processing - initiates both MediaConvert (HLS) and AssemblyAI transcription in parallel
export const startProcessing = new sst.aws.Function("StartProcessing", {
  name: `narrows-${$app.stage}-start-processing`,
  handler: "packages/functions/src/start-processing/handler.main",
  runtime: "nodejs20.x",
  timeout: "2 minutes",
  memory: "512 MB",
  concurrency: { reserved: 1 },
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
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [processingQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    MEDIACONVERT_ENDPOINT: process.env.MEDIACONVERT_ENDPOINT ?? "",
    MEDIACONVERT_ROLE_ARN: process.env.MEDIACONVERT_ROLE_ARN ?? "",
    ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "",
    ASSEMBLYAI_WEBHOOK_URL: onTranscriptionWebhook.url,
  },
});
processingQueue.subscribe(startProcessing.arn);

// Process Transcript - identifies speakers, chapters, segments and sends to Graphiti
// Runs in VPC to access internal Graphiti service
export const processTranscript = new sst.aws.Function("ProcessTranscript", {
  name: `narrows-${$app.stage}-process-transcript`,
  handler: "packages/functions/src/process-transcript/handler.main",
  runtime: "nodejs20.x",
  timeout: "15 minutes",
  memory: "1024 MB",
  concurrency: { reserved: 1 },
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
transcriptIngestQueue.subscribe(processTranscript.arn);

// On MediaConvert Complete - handles MediaConvert completion events
export const onMediaConvertComplete = new sst.aws.Function("OnMediaConvertComplete", {
  name: `narrows-${$app.stage}-on-mediaconvert-complete`,
  handler: "packages/functions/src/on-media-convert-complete/handler.main",
  runtime: "nodejs20.x",
  timeout: "1 minute",
  memory: "256 MB",
  concurrency: { reserved: 1 },
  logging: {
    logGroup: `/aws/lambda/narrows-${$app.stage}-on-mediaconvert-complete`,
  },
  environment: commonEnv,
});

// On Transcribe Complete - handles Transcribe completion events
export const onTranscribeComplete = new sst.aws.Function("OnTranscribeComplete", {
  name: `narrows-${$app.stage}-on-transcribe-complete`,
  handler: "packages/functions/src/on-transcribe-complete/handler.main",
  runtime: "nodejs20.x",
  timeout: "1 minute",
  memory: "256 MB",
  concurrency: { reserved: 1 },
  logging: {
    logGroup: `/aws/lambda/narrows-${$app.stage}-on-transcribe-complete`,
  },
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
// Uses sharp which requires platform-specific installation for Lambda
export const resizeImage = new sst.aws.Function("ResizeImage", {
  name: `narrows-${$app.stage}-resize-image`,
  handler: "packages/functions/src/resize-image/handler.main",
  runtime: "nodejs20.x",
  timeout: "30 seconds",
  memory: "1024 MB",
  concurrency: { reserved: 1 },
  url: {
    authorization: "none",
  },
  permissions: [
    {
      actions: ["s3:GetObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
  ],
  environment: commonEnv,
  nodejs: {
    install: ["sharp"],
  },
});

new aws.lambda.Permission("ResizeImagePublicInvoke", {
  function: `narrows-${$app.stage}-resize-image`,
  action: "lambda:InvokeFunction",
  principal: "*",
  statementId: "FunctionURLInvokeAllowPublicAccess",
});

// Ingest Listening Events - receives listening events from SQS and posts to narrows API
export const ingestListeningEvents = new sst.aws.Function("IngestListeningEvents", {
  name: `narrows-${$app.stage}-ingest-listening-events`,
  handler: "packages/functions/src/ingest-listening-events/handler.main",
  runtime: "nodejs20.x",
  timeout: "1 minute",
  memory: "256 MB",
  concurrency: { reserved: 1 },
  permissions: [
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [listeningEventsQueue.arn],
    },
  ],
  environment: commonEnv,
});
listeningEventsQueue.subscribe(ingestListeningEvents.arn);

// Rollup Listening - hourly consistency sweep for listening summaries and patterns
// Triggered by EventBridge schedule (configured in events.ts)
export const rollupListening = new sst.aws.Function("RollupListening", {
  name: `narrows-${$app.stage}-rollup-listening`,
  handler: "packages/functions/src/rollup-listening/handler.main",
  runtime: "nodejs20.x",
  timeout: "5 minutes",
  memory: "512 MB",
  concurrency: { reserved: 1 },
  environment: commonEnv,
});

// Build Taste Profiles - periodic computation of user taste vectors
// Reads listening summaries + segment metadata from narrows API,
// entity associations from Graphiti, and upserts taste profiles.
// Triggered by EventBridge schedule (configured in events.ts)
export const buildTasteProfiles = new sst.aws.Function("BuildTasteProfiles", {
  name: `narrows-${$app.stage}-build-taste-profiles`,
  handler: "packages/functions/src/build-taste-profiles/handler.main",
  runtime: "nodejs20.x",
  timeout: "10 minutes",
  memory: "512 MB",
  concurrency: { reserved: 1 },
  vpc: vpcConfig,
  environment: {
    ...commonEnv,
    GRAPHITI_API_URL: process.env.GRAPHITI_API_URL ?? "",
    GRAPHITI_API_KEY: process.env.GRAPHITI_API_KEY ?? "",
    GRAPHITI_GRAPH_ID: process.env.GRAPHITI_GRAPH_ID ?? "",
  },
});

// Discover Episodes - LLM-driven current-events podcast discovery
// Uses OpenAI Responses API (web_search) + PodcastIndex to find relevant episodes,
// then upserts series/episodes in Narrows and seeds topics in Graphiti.
export const discoverEpisodes = new sst.aws.Function("DiscoverEpisodes", {
  name: `narrows-${$app.stage}-discover-episodes`,
  handler: "packages/functions/src/discover-episodes/handler.main",
  runtime: "nodejs20.x",
  timeout: "10 minutes",
  memory: "1024 MB",
  concurrency: { reserved: 1 },
  vpc: vpcConfig,
  permissions: [
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [discoveryQueue.arn],
    },
    {
      actions: ["sqs:SendMessage"],
      resources: [audioDownloadQueue.arn, imageDownloadQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
    PODCASTINDEX_API_KEY: process.env.PODCASTINDEX_API_KEY ?? "",
    PODCASTINDEX_API_SECRET: process.env.PODCASTINDEX_API_SECRET ?? "",
    GRAPHITI_API_URL: process.env.GRAPHITI_API_URL ?? "",
    GRAPHITI_API_KEY: process.env.GRAPHITI_API_KEY ?? "",
    GRAPHITI_GRAPH_ID: process.env.GRAPHITI_GRAPH_ID ?? "",
    AUDIO_DOWNLOAD_QUEUE_URL: audioDownloadQueue.url,
    IMAGE_DOWNLOAD_QUEUE_URL: imageDownloadQueue.url,
  },
  link: [audioDownloadQueue, imageDownloadQueue],
});
discoveryQueue.subscribe(discoverEpisodes.arn);

// Export the Lambda ARNs for EventBridge rule setup
export const lambdaArns = {
  onMediaConvertComplete: onMediaConvertComplete.arn,
  onTranscribeComplete: onTranscribeComplete.arn,
};
