/**
 * Check Stale Transcriptions Lambda
 *
 * Runs every 15 minutes to recover episodes whose AssemblyAI transcription
 * completed but whose webhook was never delivered (or our handler failed).
 *
 * For each episode stuck in "processing" for > 30 minutes:
 *   - Poll AssemblyAI to check the current transcript status
 *   - If completed: run the full completion flow (fetch, adapt, write S3, enqueue)
 *   - If error: mark episode as failed
 *   - If still in progress: skip (not yet stale enough)
 */

import type { Handler } from "aws-lambda";
import { completeTranscription, updateEpisode } from "../on-transcription-webhook/complete-transcription";

interface EpisodeRow {
  id: string;
  audioMediaId: string | null;
  transcribeJobName: string | null; // Stores AssemblyAI transcript ID
  processingStatus: string | null;
  updatedAt: string;
}

interface AssemblyAIStatusResponse {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  error?: string;
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch all episodes currently in "processing" status from the Narrows API.
 * Filters client-side to those not updated in > STALE_THRESHOLD_MS.
 */
async function fetchStaleEpisodes(
  apiUrl: string,
  apiKey: string
): Promise<EpisodeRow[]> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const episodes: EpisodeRow[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const url = `${apiUrl}/api/v1/episodes?processingStatus=processing&limit=${limit}&offset=${offset}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      console.error(`Failed to fetch processing episodes: ${response.status}`);
      break;
    }

    const { data, hasMore } = (await response.json()) as {
      data: EpisodeRow[];
      hasMore: boolean;
    };

    for (const episode of data) {
      if (new Date(episode.updatedAt) < cutoff) {
        episodes.push(episode);
      }
    }

    if (!hasMore) break;
    offset += limit;
  }

  return episodes;
}

/**
 * Poll AssemblyAI for the current status of a transcript.
 */
async function pollAssemblyAIStatus(
  transcriptId: string,
  apiKey: string
): Promise<AssemblyAIStatusResponse> {
  const response = await fetch(
    `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
    { headers: { Authorization: apiKey } }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `AssemblyAI status poll failed: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<AssemblyAIStatusResponse>;
}

/**
 * Check Stale Transcriptions — EventBridge Cron handler
 */
export const main: Handler = async () => {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;
  const assemblyApiKey = process.env.ASSEMBLYAI_API_KEY;
  const bucketName = process.env.MEDIA_BUCKET_NAME;
  const subtitleGenerationQueueUrl = process.env.SUBTITLE_GENERATION_QUEUE_URL;

  if (!apiUrl || !apiKey || !assemblyApiKey || !bucketName || !subtitleGenerationQueueUrl) {
    throw new Error("Missing required environment variables");
  }

  console.log("Checking for stale transcription jobs...");

  const staleEpisodes = await fetchStaleEpisodes(apiUrl, apiKey);
  console.log(`Found ${staleEpisodes.length} stale episodes in "processing" state`);

  for (const episode of staleEpisodes) {
    const transcriptId = episode.transcribeJobName;
    const audioMediaId = episode.audioMediaId;

    if (!transcriptId || !audioMediaId) {
      console.warn(
        `Episode ${episode.id} is processing but has no transcribeJobName or audioMediaId — skipping`
      );
      continue;
    }

    console.log(
      `Checking episode ${episode.id} with AssemblyAI transcript ${transcriptId}`
    );

    try {
      const statusResponse = await pollAssemblyAIStatus(transcriptId, assemblyApiKey);

      if (statusResponse.status === "completed") {
        console.log(
          `Episode ${episode.id}: AssemblyAI transcript ${transcriptId} is complete — recovering`
        );
        await completeTranscription({
          transcriptId,
          episodeId: episode.id,
          audioMediaId,
          assemblyApiKey,
          bucketName,
          subtitleGenerationQueueUrl,
        });
        console.log(`Episode ${episode.id}: recovery complete`);
      } else if (statusResponse.status === "error") {
        console.error(
          `Episode ${episode.id}: AssemblyAI transcript ${transcriptId} failed: ${statusResponse.error}`
        );
        await updateEpisode(episode.id, {
          processingStatus: "failed",
          processingError: `AssemblyAI transcription failed: ${statusResponse.error ?? "Unknown error"}`,
        });
      } else {
        console.log(
          `Episode ${episode.id}: transcript status is "${statusResponse.status}" — still in progress, skipping`
        );
      }
    } catch (error) {
      console.error(
        `Error checking episode ${episode.id} (transcript ${transcriptId}):`,
        error
      );
      // Don't mark failed — it will be retried on the next cron run
    }
  }

  console.log("Stale transcription check complete");
};
