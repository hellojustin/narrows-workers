/**
 * EventBridge configuration
 *
 * Note: MediaConvert and Transcribe emit events to the DEFAULT EventBridge bus.
 * We create EventBridge rules via AWS CLI after deployment to trigger our Lambda functions.
 *
 * Rules needed:
 * 1. MediaConvert Job State Change -> onMediaConvertComplete Lambda
 * 2. Transcribe Job State Change -> onTranscribeComplete Lambda
 *
 * These are set up in the deployment step, not via SST, because SST v3
 * doesn't have native support for EventBridge rule subscriptions to the default bus.
 */

import { rollupListening, buildTasteProfiles, checkStaleTranscriptions, discoverEpisodes } from "./functions";

// Placeholder export to satisfy the import in sst.config.ts
export const eventBridgeConfig = {
  mediaConvertPattern: {
    source: ["aws.mediaconvert"],
    "detail-type": ["MediaConvert Job State Change"],
    detail: {
      status: ["COMPLETE", "ERROR"],
    },
  },
  transcribePattern: {
    source: ["aws.transcribe"],
    "detail-type": ["Transcribe Job State Change"],
    detail: {
      TranscriptionJobStatus: ["COMPLETED", "FAILED"],
    },
  },
};

// Hourly schedule to invoke the RollupListening Lambda
// Uses SST's Cron construct to create an EventBridge scheduled rule
export const rollupSchedule = new sst.aws.Cron("RollupListeningSchedule", {
  schedule: "rate(1 hour)",
  function: rollupListening.arn,
});

// Rebuild taste profiles for users with new listening data
export const tasteProfileSchedule = new sst.aws.Cron("TasteProfileSchedule", {
  schedule: "rate(5 minutes)",
  function: buildTasteProfiles.arn,
});

// Recover episodes where AssemblyAI webhook was missed or our handler failed
export const staleTranscriptionSchedule = new sst.aws.Cron("StaleTranscriptionSchedule", {
  schedule: "rate(15 minutes)",
  function: checkStaleTranscriptions.arn,
});

// LLM-driven current-events podcast discovery
// Loads active DiscoveryPrompts from Narrows, runs web-search + PodcastIndex lookups,
// upserts series/episodes, and seeds topics in Graphiti.
export const discoverySchedule = new sst.aws.Cron("DiscoverySchedule", {
  schedule: "rate(30 minutes)",
  function: discoverEpisodes.arn,
});
