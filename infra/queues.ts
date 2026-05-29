/**
 * SQS Queue definitions for the ingestion pipeline.
 * Every queue has a dead-letter queue (DLQ) to cap retries and prevent
 * infinite retry storms. DLQs retain messages for 14 days to allow
 * investigation and manual redrive before expiry.
 */

// --- Dead-letter queues (14-day retention) ---

const DLQ_RETENTION_SECONDS = 1_209_600; // 14 days

const rssRefreshDlq = new sst.aws.Queue("RssRefreshDlq", {
  fifo: false,
  transform: { queue: { name: `narrows-${$app.stage}-rss-refresh-dlq`, messageRetentionSeconds: DLQ_RETENTION_SECONDS } },
});

const audioDownloadDlq = new sst.aws.Queue("AudioDownloadDlq", {
  fifo: false,
  transform: { queue: { name: `narrows-${$app.stage}-audio-download-dlq`, messageRetentionSeconds: DLQ_RETENTION_SECONDS } },
});

const imageDownloadDlq = new sst.aws.Queue("ImageDownloadDlq", {
  fifo: false,
  transform: { queue: { name: `narrows-${$app.stage}-image-download-dlq`, messageRetentionSeconds: DLQ_RETENTION_SECONDS } },
});

const imageProcessingDlq = new sst.aws.Queue("ImageProcessingDlq", {
  fifo: false,
  transform: { queue: { name: `narrows-${$app.stage}-image-processing-dlq`, messageRetentionSeconds: DLQ_RETENTION_SECONDS } },
});

const processingDlq = new sst.aws.Queue("ProcessingDlq", {
  fifo: false,
  transform: { queue: { name: `narrows-${$app.stage}-processing-dlq`, messageRetentionSeconds: DLQ_RETENTION_SECONDS } },
});

const transcriptIngestDlq = new sst.aws.Queue("TranscriptIngestDlq", {
  fifo: false,
  transform: { queue: { name: `narrows-${$app.stage}-transcript-ingest-dlq`, messageRetentionSeconds: DLQ_RETENTION_SECONDS } },
});

const listeningEventsDlq = new sst.aws.Queue("ListeningEventsDlq", {
  fifo: false,
  transform: { queue: { name: `narrows-${$app.stage}-listening-events-dlq`, messageRetentionSeconds: DLQ_RETENTION_SECONDS } },
});

const discoveryDlq = new sst.aws.Queue("DiscoveryDlq", {
  fifo: false,
  transform: { queue: { name: `narrows-${$app.stage}-discovery-dlq`, messageRetentionSeconds: DLQ_RETENTION_SECONDS } },
});

const subtitleGenerationDlq = new sst.aws.Queue("SubtitleGenerationDlq", {
  fifo: false,
  transform: { queue: { name: `narrows-${$app.stage}-subtitle-generation-dlq`, messageRetentionSeconds: DLQ_RETENTION_SECONDS } },
});

// --- Primary queues ---

export const rssRefreshQueue = new sst.aws.Queue("RssRefreshQueue", {
  fifo: false,
  visibilityTimeout: "5 minutes",
  dlq: { retry: 3, queue: rssRefreshDlq.arn },
  transform: {
    queue: { name: `narrows-${$app.stage}-rss-refresh` },
  },
});

export const audioDownloadQueue = new sst.aws.Queue("AudioDownloadQueue", {
  fifo: false,
  visibilityTimeout: "10 minutes",
  dlq: { retry: 3, queue: audioDownloadDlq.arn },
  transform: {
    queue: { name: `narrows-${$app.stage}-audio-download` },
  },
});

export const imageDownloadQueue = new sst.aws.Queue("ImageDownloadQueue", {
  fifo: false,
  visibilityTimeout: "5 minutes",
  dlq: { retry: 3, queue: imageDownloadDlq.arn },
  transform: {
    queue: { name: `narrows-${$app.stage}-image-download` },
  },
});

export const imageProcessingQueue = new sst.aws.Queue("ImageProcessingQueue", {
  fifo: false,
  visibilityTimeout: "5 minutes",
  dlq: { retry: 3, queue: imageProcessingDlq.arn },
  transform: {
    queue: { name: `narrows-${$app.stage}-image-processing` },
  },
});

export const processingQueue = new sst.aws.Queue("ProcessingQueue", {
  fifo: false,
  visibilityTimeout: "2 minutes",
  dlq: { retry: 3, queue: processingDlq.arn },
  transform: {
    queue: { name: `narrows-${$app.stage}-processing` },
  },
});

export const transcriptIngestQueue = new sst.aws.Queue("TranscriptIngestQueue", {
  fifo: false,
  visibilityTimeout: "16 minutes",
  dlq: { retry: 3, queue: transcriptIngestDlq.arn },
  transform: {
    queue: { name: `narrows-${$app.stage}-transcript-ingest` },
  },
});

export const listeningEventsQueue = new sst.aws.Queue("ListeningEventsQueue", {
  fifo: false,
  visibilityTimeout: "2 minutes",
  dlq: { retry: 3, queue: listeningEventsDlq.arn },
  transform: {
    queue: { name: `narrows-${$app.stage}-listening-events` },
  },
});

export const discoveryQueue = new sst.aws.Queue("DiscoveryQueue", {
  fifo: false,
  visibilityTimeout: "10 minutes",
  dlq: { retry: 3, queue: discoveryDlq.arn },
  transform: {
    queue: { name: `narrows-${$app.stage}-discovery` },
  },
});

export const subtitleGenerationQueue = new sst.aws.Queue("SubtitleGenerationQueue", {
  fifo: false,
  visibilityTimeout: "5 minutes",
  dlq: { retry: 3, queue: subtitleGenerationDlq.arn },
  transform: {
    queue: { name: `narrows-${$app.stage}-subtitle-generation` },
  },
});
