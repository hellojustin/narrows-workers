/**
 * SQS Queue definitions for the ingestion pipeline
 */

// Queue for triggering RSS feed refreshes
export const rssRefreshQueue = new sst.aws.Queue("RssRefreshQueue", {
  fifo: false,
  visibilityTimeout: "5 minutes",
  transform: {
    queue: {
      name: `narrows-${$app.stage}-rss-refresh`,
    },
  },
});

// Queue for downloading audio files
export const audioDownloadQueue = new sst.aws.Queue("AudioDownloadQueue", {
  fifo: false,
  visibilityTimeout: "10 minutes", // Downloads can take a while
  transform: {
    queue: {
      name: `narrows-${$app.stage}-audio-download`,
    },
  },
});

// Queue for downloading image files (series and episode artwork)
export const imageDownloadQueue = new sst.aws.Queue("ImageDownloadQueue", {
  fifo: false,
  visibilityTimeout: "5 minutes",
  transform: {
    queue: {
      name: `narrows-${$app.stage}-image-download`,
    },
  },
});

// Queue for processing downloaded images (converting to base formats)
export const imageProcessingQueue = new sst.aws.Queue("ImageProcessingQueue", {
  fifo: false,
  visibilityTimeout: "5 minutes",
  transform: {
    queue: {
      name: `narrows-${$app.stage}-image-processing`,
    },
  },
});

// Queue for starting MediaConvert and AssemblyAI transcription
export const processingQueue = new sst.aws.Queue("ProcessingQueue", {
  fifo: false,
  visibilityTimeout: "2 minutes",
  transform: {
    queue: {
      name: `narrows-${$app.stage}-processing`,
    },
  },
});

// Queue for ingesting transcripts into Graphiti
export const transcriptIngestQueue = new sst.aws.Queue("TranscriptIngestQueue", {
  fifo: false,
  visibilityTimeout: "16 minutes", // Must be >= Lambda timeout (15 min) + buffer
  transform: {
    queue: {
      name: `narrows-${$app.stage}-transcript-ingest`,
    },
  },
});

// Queue for ingesting listening events from the narrows API
export const listeningEventsQueue = new sst.aws.Queue("ListeningEventsQueue", {
  fifo: false,
  visibilityTimeout: "2 minutes",
  transform: {
    queue: {
      name: `narrows-${$app.stage}-listening-events`,
    },
  },
});
