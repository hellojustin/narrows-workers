/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "narrows",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
      providers: {
        aws: {
          region: "us-east-1",
        },
      },
    };
  },
  async run() {
    await import("./infra/storage");
    const queues = await import("./infra/queues");
    await import("./infra/events");
    await import("./infra/functions");

    return {
      rssRefreshQueueUrl: queues.rssRefreshQueue.url,
      audioDownloadQueueUrl: queues.audioDownloadQueue.url,
      imageDownloadQueueUrl: queues.imageDownloadQueue.url,
      imageProcessingQueueUrl: queues.imageProcessingQueue.url,
      processingQueueUrl: queues.processingQueue.url,
      transcriptIngestQueueUrl: queues.transcriptIngestQueue.url,
      listeningEventsQueueUrl: queues.listeningEventsQueue.url,
      transcriptionWebhookUrl: (await import("./infra/functions")).onTranscriptionWebhook.url,
    };
  },
});
