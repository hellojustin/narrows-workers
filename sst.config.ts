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
    // Layers before functions: the ffmpeg functions reference the layer ARN.
    await import("./infra/layers");
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
      discoveryQueueUrl: queues.discoveryQueue.url,
      subtitleGenerationQueueUrl: queues.subtitleGenerationQueue.url,
      audioTranscodeQueueUrl: queues.audioTranscodeQueue.url,
      audioAnalysisQueueUrl: queues.audioAnalysisQueue.url,
      transcriptionWebhookUrl: (await import("./infra/functions")).onTranscriptionWebhook.url,
    };
  },
});
