/**
 * Lambda function definitions for the ingestion pipeline.
 * Concurrency is tuned per-function based on expected throughput and
 * downstream capacity. All SQS-triggered handlers use batch size 1
 * (one message per Lambda invocation) to avoid batch poisoning and
 * simplify error handling.
 */

import { mediaBucketName } from "./storage";
import { ffmpegLayerArn, ffmpegEnv, FFMPEG_ARCHITECTURE } from "./layers";
import {
  rssRefreshQueue,
  audioDownloadQueue,
  imageDownloadQueue,
  imageProcessingQueue,
  processingQueue,
  transcriptIngestQueue,
  listeningEventsQueue,
  discoveryQueue,
  subtitleGenerationQueue,
  audioTranscodeQueue,
  audioAnalysisQueue,
} from "./queues";

// VPC configuration for Lambda functions
// Required for accessing internal services like Graphiti
//
// Placeholder ids are treated as absent. .env.example ships `subnet-xxx` and
// `sg-xxx`, and passing those through makes CreateFunction fail with
// "Error occurred while DescribeSecurityGroups", which aborts the whole deploy on
// the first VPC-attached function rather than saying which value is wrong.
const AWS_ID_PATTERN = /^(subnet|sg)-[0-9a-f]{8,}$/;

function parseVpcIds(raw: string | undefined, kind: "subnet" | "sg"): string[] {
  const ids = (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const invalid = ids.filter((id) => !AWS_ID_PATTERN.test(id));
  if (invalid.length > 0) {
    console.warn(
      `Ignoring VPC configuration: ${invalid.join(", ")} ${
        invalid.length === 1 ? "is not a valid" : "are not valid"
      } ${kind} id. Functions that need the VPC will deploy without one.`
    );
    return [];
  }
  return ids;
}

const vpcSubnets = parseVpcIds(process.env.VPC_SUBNET_IDS, "subnet");
const vpcSecurityGroups = parseVpcIds(process.env.VPC_SECURITY_GROUP_IDS, "sg");

const vpcConfig =
  vpcSubnets.length > 0 && vpcSecurityGroups.length > 0
    ? { securityGroups: vpcSecurityGroups, privateSubnets: vpcSubnets }
    : undefined;

// Common environment variables for all functions
const commonEnv = {
  MEDIA_BUCKET_NAME: mediaBucketName,
  NARROWS_API_URL: process.env.NARROWS_API_URL ?? "",
  NARROWS_API_KEY: process.env.NARROWS_API_KEY ?? "",
  // Lambda already defaults to UTC, but these handlers compute time windows
  // that narrows uses to bucket listening and revenue by day. Stating it keeps
  // the boundary from moving if that default ever does.
  TZ: "UTC",
};

// Fetch RSS - fetches and parses RSS feeds, batch-syncs episodes
export const fetchRss = new sst.aws.Function("FetchRss", {
  name: `narrows-${$app.stage}-fetch-rss`,
  handler: "packages/functions/src/fetch-rss/handler.main",
  runtime: "nodejs20.x",
  timeout: "2 minutes",
  memory: "512 MB",
  concurrency: { reserved: 3 },
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
rssRefreshQueue.subscribe(fetchRss.arn, {
  batch: { size: 1 },
});

// Download Audio - downloads audio files to S3
export const downloadAudio = new sst.aws.Function("DownloadAudio", {
  name: `narrows-${$app.stage}-download-audio`,
  handler: "packages/functions/src/download-audio/handler.main",
  runtime: "nodejs20.x",
  timeout: "10 minutes",
  memory: "1024 MB",
  concurrency: { reserved: 3 },
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
audioDownloadQueue.subscribe(downloadAudio.arn, {
  batch: { size: 1 },
});

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
imageDownloadQueue.subscribe(downloadImage.arn, {
  batch: { size: 1 },
});

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
imageProcessingQueue.subscribe(processImage.arn, {
  batch: { size: 1 },
});

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
      actions: ["s3:PutObject", "s3:GetObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
    {
      actions: ["sqs:SendMessage"],
      resources: [subtitleGenerationQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "",
    SUBTITLE_GENERATION_QUEUE_URL: subtitleGenerationQueue.url,
  },
  link: [subtitleGenerationQueue],
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
      actions: ["s3:PutObject", "s3:GetObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
    {
      actions: ["sqs:SendMessage"],
      resources: [subtitleGenerationQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "",
    SUBTITLE_GENERATION_QUEUE_URL: subtitleGenerationQueue.url,
  },
  link: [subtitleGenerationQueue],
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
    {
      actions: ["sqs:SendMessage"],
      resources: [audioTranscodeQueue.arn, audioAnalysisQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    MEDIACONVERT_ENDPOINT: process.env.MEDIACONVERT_ENDPOINT ?? "",
    MEDIACONVERT_ROLE_ARN: process.env.MEDIACONVERT_ROLE_ARN ?? "",
    ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "",
    ASSEMBLYAI_WEBHOOK_URL: onTranscriptionWebhook.url,
    AUDIO_TRANSCODE_QUEUE_URL: audioTranscodeQueue.url,
    AUDIO_ANALYSIS_QUEUE_URL: audioAnalysisQueue.url,
    // Transcoder rollout. Defaults to MediaConvert when unset; see
    // packages/functions/src/shared/transcoder-routing.ts.
    TRANSCODER: process.env.TRANSCODER ?? "",
    FFMPEG_TRANSCODE_SERIES_IDS: process.env.FFMPEG_TRANSCODE_SERIES_IDS ?? "",
    FFMPEG_TRANSCODE_PERCENT: process.env.FFMPEG_TRANSCODE_PERCENT ?? "",
    FFMPEG_TRANSCODE_SHADOW: process.env.FFMPEG_TRANSCODE_SHADOW ?? "",
  },
  link: [audioTranscodeQueue, audioAnalysisQueue],
});
processingQueue.subscribe(startProcessing.arn, {
  batch: { size: 1 },
});

// Process Transcript - identifies speakers, chapters, segments and sends to Graphiti
// Runs in VPC to access internal Graphiti service
export const processTranscript = new sst.aws.Function("ProcessTranscript", {
  name: `narrows-${$app.stage}-process-transcript`,
  handler: "packages/functions/src/process-transcript/handler.main",
  runtime: "nodejs20.x",
  timeout: "15 minutes",
  memory: "1024 MB",
  concurrency: { reserved: 3 },
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
transcriptIngestQueue.subscribe(processTranscript.arn, {
  batch: { size: 1 },
});

// Generate HLS Subtitles - segments transcript.json into WebVTT and patches master manifest
export const generateHlsSubtitles = new sst.aws.Function("GenerateHlsSubtitles", {
  name: `narrows-${$app.stage}-generate-hls-subtitles`,
  handler: "packages/functions/src/generate-hls-subtitles/handler.main",
  runtime: "nodejs20.x",
  timeout: "5 minutes",
  memory: "512 MB",
  concurrency: { reserved: 3 },
  permissions: [
    {
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [subtitleGenerationQueue.arn],
    },
    {
      actions: ["sqs:SendMessage"],
      resources: [transcriptIngestQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    TRANSCRIPT_INGEST_QUEUE_URL: transcriptIngestQueue.url,
  },
  link: [transcriptIngestQueue],
});
subtitleGenerationQueue.subscribe(generateHlsSubtitles.arn, {
  batch: { size: 1 },
});

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
  permissions: [
    {
      actions: ["s3:GetObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
    {
      actions: ["sqs:SendMessage"],
      resources: [subtitleGenerationQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    SUBTITLE_GENERATION_QUEUE_URL: subtitleGenerationQueue.url,
  },
  link: [subtitleGenerationQueue],
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
listeningEventsQueue.subscribe(ingestListeningEvents.arn, {
  batch: { size: 1 },
});

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
discoveryQueue.subscribe(discoverEpisodes.arn, {
  batch: { size: 1 },
});

/**
 * ffmpeg functions.
 *
 * Both run on arm64 with the static ffmpeg layer.
 *
 * 1769 MB is where Lambda allocates one full vCPU. Measured on the dev stage
 * against a 9-minute episode, raising memory does not make the transcode faster,
 * because the AAC encoder is single-threaded:
 *
 *    1769 MB  29.0 s   18.7x realtime
 *    3538 MB  32.2 s   16.8x
 *    5307 MB  32.3 s   16.8x
 *   10240 MB  32.5 s   16.7x
 *
 * Since Lambda bills memory multiplied by time, anything above 1769 MB costs
 * proportionally more for no gain: $0.0114 against $0.0742 for the same work.
 *
 * On a 2h35m episode, 1769 MB ran it in 400.6 s, 23.1x realtime. The longest
 * episode in the catalogue is 4h34m, which projects to 710 s against the 900 s
 * ceiling, leaving 21% headroom. Episodes long enough to threaten that are rare:
 * 14 over three hours, one over four.
 */
const FFMPEG_MEMORY = "1769 MB";

// Transcode Audio - HLS transcode with ffmpeg, replaces the MediaConvert job
export const transcodeAudio = new sst.aws.Function("TranscodeAudio", {
  name: `narrows-${$app.stage}-transcode-audio`,
  handler: "packages/functions/src/transcode-audio/handler.main",
  runtime: "nodejs20.x",
  architecture: FFMPEG_ARCHITECTURE,
  timeout: "15 minutes",
  memory: FFMPEG_MEMORY,
  // A 4h34m episode produces about 264 MB of segments. ffmpeg reads its input
  // over HTTPS rather than downloading it, so nothing else occupies /tmp.
  storage: "4096 MB",
  concurrency: { reserved: 3 },
  layers: [ffmpegLayerArn],
  permissions: [
    {
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [audioTranscodeQueue.arn],
    },
    {
      actions: ["sqs:SendMessage"],
      resources: [subtitleGenerationQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    ...ffmpegEnv,
    SUBTITLE_GENERATION_QUEUE_URL: subtitleGenerationQueue.url,
  },
  link: [subtitleGenerationQueue],
});
audioTranscodeQueue.subscribe(transcodeAudio.arn, {
  batch: { size: 1 },
});

// Analyze Audio - waveform peaks and per-frequency-band energy
export const analyzeAudio = new sst.aws.Function("AnalyzeAudio", {
  name: `narrows-${$app.stage}-analyze-audio`,
  handler: "packages/functions/src/analyze-audio/handler.main",
  runtime: "nodejs20.x",
  architecture: FFMPEG_ARCHITECTURE,
  timeout: "15 minutes",
  memory: FFMPEG_MEMORY,
  // The analysis streams decoded PCM and writes one output object, so it needs
  // far less scratch space than the transcode.
  storage: "1024 MB",
  concurrency: { reserved: 3 },
  layers: [ffmpegLayerArn],
  permissions: [
    {
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [`arn:aws:s3:::${mediaBucketName}/*`],
    },
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [audioAnalysisQueue.arn],
    },
  ],
  environment: {
    ...commonEnv,
    ...ffmpegEnv,
  },
});
audioAnalysisQueue.subscribe(analyzeAudio.arn, {
  batch: { size: 1 },
});

/**
 * Measure Ffmpeg - throughput measurement, non-production stages only.
 *
 * The memory setting for the two ffmpeg functions has to come from measurements on
 * Lambda rather than a laptop, and this bypasses the episode-ingestible guard,
 * which a non-production stage cannot satisfy. It writes only to scratch/.
 */
export const measureFfmpeg =
  $app.stage === "production"
    ? undefined
    : new sst.aws.Function("MeasureFfmpeg", {
        name: `narrows-${$app.stage}-measure-ffmpeg`,
        handler: "packages/functions/src/measure-ffmpeg/handler.main",
        runtime: "nodejs20.x",
        architecture: FFMPEG_ARCHITECTURE,
        timeout: "15 minutes",
        memory: FFMPEG_MEMORY,
        storage: "4096 MB",
        layers: [ffmpegLayerArn],
        permissions: [
          {
            actions: ["s3:GetObject", "s3:PutObject"],
            resources: [`arn:aws:s3:::${mediaBucketName}/*`],
          },
        ],
        environment: {
          ...commonEnv,
          ...ffmpegEnv,
        },
      });

// Export the Lambda ARNs for EventBridge rule setup
export const lambdaArns = {
  onMediaConvertComplete: onMediaConvertComplete.arn,
  onTranscribeComplete: onTranscribeComplete.arn,
};
