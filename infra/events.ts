/**
 * EventBridge configuration
 *
 * Scheduled work only. MediaConvert and Transcribe default-bus rules are
 * leftover from the AWS-managed job path and are not created here. Remove
 * them with docs/eventbridge-teardown.md. After PROD-168 the leftover
 * handlers (on-media-convert-complete, on-transcribe-complete) go away.
 *
 * mediaConvertPattern and transcribePattern were documentation-only and
 * unused; they are gone from this file.
 */

import { rollupListening, buildTasteProfiles, checkStaleTranscriptions, discoverEpisodes } from "./functions";

/**
 * Scheduled work only runs in production.
 *
 * These crons call the Narrows API, Graphiti, OpenAI and PodcastIndex with the
 * credentials in the stage's env file. In a non-production stage that means real
 * spend and, because .env.dev points GRAPHITI_API_URL at the production Graphiti,
 * writes to the live knowledge graph. Deploy a dev stage and they start firing
 * within five minutes. Invoke the functions directly when testing them.
 */
const scheduledWorkEnabled = $app.stage === "production";

// Hourly schedule to invoke the RollupListening Lambda
// Uses SST's Cron construct to create an EventBridge scheduled rule
export const rollupSchedule = scheduledWorkEnabled
  ? new sst.aws.Cron("RollupListeningSchedule", {
      schedule: "rate(1 hour)",
      function: rollupListening.arn,
    })
  : undefined;

// Rebuild taste profiles for users with new listening data
export const tasteProfileSchedule = scheduledWorkEnabled
  ? new sst.aws.Cron("TasteProfileSchedule", {
      schedule: "rate(5 minutes)",
      function: buildTasteProfiles.arn,
    })
  : undefined;

// Recover episodes where AssemblyAI webhook was missed or our handler failed
export const staleTranscriptionSchedule = scheduledWorkEnabled
  ? new sst.aws.Cron("StaleTranscriptionSchedule", {
      schedule: "rate(15 minutes)",
      function: checkStaleTranscriptions.arn,
    })
  : undefined;

// LLM-driven current-events podcast discovery
// Loads active DiscoveryPrompts from Narrows, runs web-search + PodcastIndex lookups,
// upserts series/episodes, and seeds topics in Graphiti.
export const discoverySchedule = scheduledWorkEnabled
  ? new sst.aws.Cron("DiscoverySchedule", {
      schedule: "rate(30 minutes)",
      function: discoverEpisodes.arn,
    })
  : undefined;
