/**
 * SQS Queue definitions for the ingestion pipeline
 */

// Queue for triggering RSS feed refreshes
export const rssRefreshQueue = new sst.aws.Queue("RssRefreshQueue", {
  fifo: false,
  visibilityTimeout: "5 minutes",
});

// Queue for downloading audio files
export const audioDownloadQueue = new sst.aws.Queue("AudioDownloadQueue", {
  fifo: false,
  visibilityTimeout: "10 minutes", // Downloads can take a while
});

// Queue for downloading image files (series and episode artwork)
export const imageDownloadQueue = new sst.aws.Queue("ImageDownloadQueue", {
  fifo: false,
  visibilityTimeout: "5 minutes",
});

// Queue for processing downloaded images (converting to base formats)
export const imageProcessingQueue = new sst.aws.Queue("ImageProcessingQueue", {
  fifo: false,
  visibilityTimeout: "5 minutes",
});

// Queue for starting MediaConvert and Transcribe processing
export const processingQueue = new sst.aws.Queue("ProcessingQueue", {
  fifo: false,
  visibilityTimeout: "2 minutes",
});

// Queue for ingesting transcripts into Graphiti
export const transcriptIngestQueue = new sst.aws.Queue("TranscriptIngestQueue", {
  fifo: false,
  visibilityTimeout: "10 minutes", // AI processing can take time
});
