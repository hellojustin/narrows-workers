/**
 * discover-episodes Lambda
 *
 * Triggered by EventBridge cron (every 30 min) or directly via SQS message.
 *
 * For each active DiscoveryPrompt, runs a 6-step pipeline:
 * 1. Discover news stories via OpenAI web search
 * 2. Find podcast episodes covering each story
 * 3. Resolve RSS URLs via PodcastIndex
 * 4. Match episodes in RSS feeds (fuzzy title matching)
 * 5. Ingest confirmed episodes (upsert series, create episodes, enqueue downloads)
 * 6. Seed topics in Graphiti for stories with confirmed content
 */

import type { SQSEvent, ScheduledEvent, Handler } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import OpenAI from 'openai';
import { discoverStories } from './steps/discover-stories';
import { findPodcasts } from './steps/find-podcasts';
import { resolveRssUrls } from './steps/resolve-rss';
import { matchEpisodesInFeeds } from './steps/match-episodes';
import { ingestEpisodes } from './steps/ingest';
import { seedTopics } from './steps/seed-topics';
import type { DiscoveryMessage, PromptRunResult } from './types';

const sqsClient = new SQSClient({});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const NARROWS_API_URL = process.env.NARROWS_API_URL!;
const NARROWS_API_KEY = process.env.NARROWS_API_KEY!;
const GRAPHITI_API_URL = process.env.GRAPHITI_API_URL!;
const GRAPHITI_API_KEY = process.env.GRAPHITI_API_KEY!;
const GRAPHITI_GRAPH_ID = process.env.GRAPHITI_GRAPH_ID!;
const AUDIO_DOWNLOAD_QUEUE_URL = process.env.AUDIO_DOWNLOAD_QUEUE_URL!;
const IMAGE_DOWNLOAD_QUEUE_URL = process.env.IMAGE_DOWNLOAD_QUEUE_URL;

// ─── Narrows API helpers ──────────────────────────────────────────────────────

async function narrowsGet<T>(path: string): Promise<T> {
  const res = await fetch(`${NARROWS_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${NARROWS_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Narrows GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function narrowsPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${NARROWS_API_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NARROWS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Narrows POST ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function narrowsPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${NARROWS_API_URL}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${NARROWS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Narrows PUT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ─── Graphiti API helper ──────────────────────────────────────────────────────

async function graphitiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${GRAPHITI_API_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GRAPHITI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Graphiti POST ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ─── Series & Episode helpers ─────────────────────────────────────────────────

async function upsertSeries(rssUrl: string): Promise<{ id: string; created: boolean; imageUrl: string | null }> {
  const result = await narrowsPut<{ data: { id: string; imageUrl?: string | null }; created: boolean }>(
    '/api/v1/series/by-rss',
    { rssUrl },
  );
  return { id: result.data.id, created: result.created, imageUrl: result.data.imageUrl ?? null };
}

async function findExistingEpisode(seriesId: string, guid: string): Promise<string | null> {
  try {
    const result = await narrowsGet<{ data: { id: string; processingStatus: string }[] }>(
      `/api/v1/series/${seriesId}/episodes?guid=${encodeURIComponent(guid)}`,
    );
    const episodes = result.data;
    if (episodes && episodes.length > 0) {
      return episodes[0].id;
    }
  } catch {
    // Treat as not found
  }
  return null;
}

async function createEpisode(
  seriesId: string,
  data: {
    guid: string;
    title: string;
    description: string | null;
    enclosureUrl: string | null;
    enclosureType: string | null;
    enclosureLength: number | null;
    publishedAt: Date | null;
    imageUrl: string | null;
    duration: number | null;
  },
): Promise<string> {
  const result = await narrowsPost<{ data: { id: string } }>(
    `/api/v1/series/${seriesId}/episodes`,
    {
      guid: data.guid,
      title: data.title,
      description: data.description,
      enclosureUrl: data.enclosureUrl,
      enclosureType: data.enclosureType,
      enclosureLength: data.enclosureLength,
      publishedAt: data.publishedAt?.toISOString() ?? null,
      imageUrl: data.imageUrl,
      duration: data.duration,
      processingStatus: 'pending',
    },
  );
  return result.data.id;
}

async function enqueueAudioDownload(episodeId: string): Promise<void> {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: AUDIO_DOWNLOAD_QUEUE_URL,
      MessageBody: JSON.stringify({ episodeId }),
    }),
  );
}

async function enqueueImageDownload(
  type: 'series' | 'episode',
  id: string,
  imageUrl: string,
): Promise<void> {
  if (!IMAGE_DOWNLOAD_QUEUE_URL) {
    console.warn('IMAGE_DOWNLOAD_QUEUE_URL not configured, skipping image download');
    return;
  }
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: IMAGE_DOWNLOAD_QUEUE_URL,
      MessageBody: JSON.stringify({ type, id, imageUrl }),
    }),
  );
}

// ─── Prompt record ────────────────────────────────────────────────────────────

type DiscoveryPromptMode = 'full' | 'topics_only';

interface DiscoveryPromptRecord {
  id: string;
  name: string;
  prompt: string;
  mode: DiscoveryPromptMode;
  scheduleMinutes: number;
  isActive: boolean;
  lastRunAt: string | null;
}

// ─── Single prompt run (6-step pipeline) ──────────────────────────────────────

async function runPrompt(promptRecord: DiscoveryPromptRecord): Promise<PromptRunResult> {
  console.log(`Starting discovery run for prompt: ${promptRecord.name} (${promptRecord.id})`);

  const runId = `${promptRecord.id}-${Date.now()}`;
  const startedAt = new Date().toISOString();
  let runError: string | undefined;
  let episodesDiscovered = 0;
  let topicSeedsCreated = 0;
  let seriesCreated = 0;

  let storiesResponse: object[] | undefined;
  let podcastsResponse: object[] | undefined;
  let matchReport: object[] | undefined;

  try {
    const stories = await discoverStories(promptRecord.prompt, openai);
    storiesResponse = stories;

    const mode = promptRecord.mode ?? 'full';

    if (mode === 'topics_only') {
      topicSeedsCreated = await seedTopics(
        stories,
        stories.map((s) => s.headline),
        runId,
        { graphitiPost, graphId: GRAPHITI_GRAPH_ID },
      );

      console.log(
        `Prompt "${promptRecord.name}" complete (topics_only): ${topicSeedsCreated} seeds`,
      );
    } else {
      const podcasts = await findPodcasts(stories, openai);
      podcastsResponse = podcasts;

      const resolved = await resolveRssUrls(podcasts);
      const matched = await matchEpisodesInFeeds(resolved);

      matchReport = matched.map((m) => ({
        podcast_title: m.podcast_title,
        episode_title: m.episode_title,
        headline: m.headline,
        rss_url: m.rss_url,
        matched_guid: m.matched_guid,
        matched_title: m.matched_title,
        match_score: m.match_score,
      }));

      const ingestResult = await ingestEpisodes(matched, {
        upsertSeries,
        findExistingEpisode,
        createEpisode,
        enqueueAudioDownload,
        enqueueImageDownload,
      });

      episodesDiscovered = ingestResult.episodesDiscovered;
      seriesCreated = ingestResult.seriesCreated;

      topicSeedsCreated = await seedTopics(
        stories,
        ingestResult.ingestedHeadlines,
        runId,
        { graphitiPost, graphId: GRAPHITI_GRAPH_ID },
      );

      console.log(
        `Prompt "${promptRecord.name}" complete: ` +
          `${episodesDiscovered} episodes, ${topicSeedsCreated} seeds, ${seriesCreated} series`,
      );
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
    console.error(`Prompt "${promptRecord.name}" failed:`, err);
  }

  try {
    await narrowsPost('/api/v1/internal/discovery', {
      promptId: promptRecord.id,
      status: runError ? 'failed' : 'complete',
      episodesDiscovered,
      topicSeedsCreated,
      seriesCreated,
      storiesResponse: storiesResponse ?? null,
      podcastsResponse: podcastsResponse ?? null,
      matchReport: matchReport ?? null,
      error: runError ?? null,
      startedAt,
    });
  } catch (logErr) {
    console.warn('Failed to log discovery run to Narrows:', logErr);
  }

  return {
    promptId: promptRecord.id,
    promptName: promptRecord.name,
    episodesDiscovered,
    topicSeedsCreated,
    seriesCreated,
    error: runError,
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function getPromptsToRun(message: DiscoveryMessage): Promise<DiscoveryPromptRecord[]> {
  const result = await narrowsGet<{ data: DiscoveryPromptRecord[] }>(
    '/api/v1/discovery/prompts?isActive=true',
  );
  const allActive = result.data || [];

  if (message.promptId) {
    return allActive.filter((p) => p.id === message.promptId);
  }

  const now = Date.now();
  return allActive.filter((p) => {
    if (!p.lastRunAt) return true;
    const lastRun = new Date(p.lastRunAt).getTime();
    const elapsedMinutes = (now - lastRun) / 60_000;
    return elapsedMinutes >= p.scheduleMinutes;
  });
}

export const main: Handler = async (event: SQSEvent | ScheduledEvent) => {
  let message: DiscoveryMessage = {};

  if ('Records' in event && event.Records?.length > 0) {
    try {
      message = JSON.parse(event.Records[0].body) as DiscoveryMessage;
    } catch {
      console.warn('Could not parse SQS message body; running all active prompts');
    }
  }

  const prompts = await getPromptsToRun(message);

  if (prompts.length === 0) {
    console.log('No prompts due to run at this time');
    return { status: 'ok', promptsRun: 0 };
  }

  console.log(`Running ${prompts.length} discovery prompt(s)`);

  const results: PromptRunResult[] = [];
  for (const prompt of prompts) {
    const result = await runPrompt(prompt);
    results.push(result);
  }

  const totalEpisodes = results.reduce((s, r) => s + r.episodesDiscovered, 0);
  const totalSeeds = results.reduce((s, r) => s + r.topicSeedsCreated, 0);
  const totalSeries = results.reduce((s, r) => s + r.seriesCreated, 0);
  const failures = results.filter((r) => r.error);

  console.log(
    `Discovery complete: ${totalEpisodes} episodes, ${totalSeeds} seeds, ${totalSeries} series across ${results.length} prompt(s)`,
  );

  if (failures.length > 0) {
    console.error(`${failures.length} prompt(s) failed:`, failures.map((f) => f.error));
  }

  return {
    status: failures.length === 0 ? 'ok' : 'partial',
    promptsRun: results.length,
    totalEpisodes,
    totalSeeds,
    totalSeries,
    results,
  };
};
