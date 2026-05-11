/**
 * discover-episodes Lambda
 *
 * Triggered by EventBridge cron (every 30 min) or directly via SQS message.
 *
 * For each active DiscoveryPrompt:
 * 1. Calls OpenAI Responses API (gpt-4o) with web_search + find_podcast_rss tools
 * 2. Parses structured output (events + podcasts)
 * 3. Seeds topics in Graphiti for each discovered event
 * 4. Upserts series (autoIngest=false) and single episode per podcast
 * 5. Enqueues discovered episodes for audio download
 * 6. Logs the run back to Narrows
 */

import type { SQSEvent, SQSHandler, ScheduledEvent, Handler } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import OpenAI from 'openai';
import { findPodcastRss } from './tools/find-podcast-rss';
import { matchEpisode } from './match-episode';
import type {
  DiscoveredEvent,
  DiscoveredPodcast,
  DiscoveryMessage,
  DiscoveryResult,
  PromptRunResult,
} from './types';

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

async function narrowsPatch(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${NARROWS_API_URL}${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${NARROWS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Narrows PATCH ${path} failed: ${res.status} ${await res.text()}`);
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

// ─── Topic seed ───────────────────────────────────────────────────────────────

async function seedTopic(
  event: DiscoveredEvent,
  runId: string,
): Promise<boolean> {
  try {
    const result = await graphitiPost<{ created: boolean }>(
      `/graphs/${GRAPHITI_GRAPH_ID}/topics/seeds`,
      {
        name: event.name,
        description: event.description,
        granularity: 'event',
        source: `discovery-run:${runId}`,
      },
    );
    return result.created;
  } catch (err) {
    console.warn(`Failed to seed topic "${event.name}":`, err);
    return false;
  }
}

// ─── Series upsert ────────────────────────────────────────────────────────────

async function upsertSeries(rssUrl: string): Promise<{ id: string; created: boolean; imageUrl: string | null }> {
  const result = await narrowsPut<{ data: { id: string; imageUrl?: string | null }; created: boolean }>(
    '/api/v1/series/by-rss',
    { rssUrl },
  );
  return { id: result.data.id, created: result.created, imageUrl: result.data.imageUrl ?? null };
}

// ─── Episode upsert ───────────────────────────────────────────────────────────

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

// ─── LLM orchestration ───────────────────────────────────────────────────────

interface DiscoveryPromptRecord {
  id: string;
  name: string;
  prompt: string;
  scheduleMinutes: number;
  isActive: boolean;
  lastRunAt: string | null;
}

/**
 * Build context about recently discovered events to reduce redundant discoveries.
 */
async function buildRecentEventsContext(): Promise<string> {
  try {
    const result = await narrowsGet<{
      data: { topicSeedsCreated: number; llmResponse: { events?: { name: string }[] } | null; startedAt: string }[];
    }>('/api/v1/discovery/runs?limit=20');

    const recentNames: string[] = [];
    for (const run of result.data || []) {
      const events = run.llmResponse?.events || [];
      for (const ev of events) {
        if (ev.name) recentNames.push(ev.name);
      }
    }

    if (recentNames.length === 0) return '';
    const unique = [...new Set(recentNames)].slice(0, 30);
    return `\n\nEvents already discovered in recent runs (avoid re-discovering these unless there are major new developments):\n${unique.map((n) => `- ${n}`).join('\n')}`;
  } catch {
    return '';
  }
}

/**
 * JSON Schema for DiscoveryResult, used with OpenAI's structured output mode.
 * Note: rssUrl is NOT included — we resolve that ourselves via PodcastIndex
 * after the LLM returns, since the LLM consistently fails to call the tool.
 */
const discoveryResultSchema = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short topic name (2-8 words)' },
          description: { type: 'string', description: '1-3 sentence description of the event/story' },
        },
        required: ['name', 'description'],
        additionalProperties: false,
      },
    },
    podcasts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          podcastName: { type: 'string', description: 'Exact podcast show name' },
          podcastHost: { type: ['string', 'null'], description: 'Host name or network, for disambiguation' },
          episodeTitle: { type: 'string', description: 'Exact title of the specific episode' },
          episodeDescription: { type: ['string', 'null'], description: 'Episode description if available' },
          publishedDate: { type: ['string', 'null'], description: 'ISO date (YYYY-MM-DD) if known' },
          relatedEvent: { type: 'string', description: 'Which event this covers (must match an events[].name exactly)' },
        },
        required: ['podcastName', 'podcastHost', 'episodeTitle', 'episodeDescription', 'publishedDate', 'relatedEvent'],
        additionalProperties: false,
      },
    },
  },
  required: ['events', 'podcasts'],
  additionalProperties: false,
} as const;

/** Raw LLM result before RSS URL resolution */
interface LlmDiscoveryResult {
  events: DiscoveredEvent[];
  podcasts: {
    podcastName: string;
    podcastHost: string | null;
    episodeTitle: string;
    episodeDescription: string | null;
    publishedDate: string | null;
    relatedEvent: string;
  }[];
}

/**
 * Use PodcastIndex to find the best RSS feed URL for a podcast name.
 * Tries the name alone first, then with the host/network for disambiguation.
 * Returns the best matching feed URL or null if no good match found.
 */
async function resolveRssUrl(
  podcastName: string,
  podcastHost: string | null,
): Promise<{ rssUrl: string; title: string } | null> {
  // Try exact podcast name first
  let feeds = await findPodcastRss(podcastName);

  // If no results and we have a host, try with host
  if (feeds.length === 0 && podcastHost) {
    feeds = await findPodcastRss(`${podcastName} ${podcastHost}`);
  }

  if (feeds.length === 0) {
    console.warn(`PodcastIndex: no results for "${podcastName}"`);
    return null;
  }

  // Filter to feeds with healthy HTTP status
  const healthy = feeds.filter((f) => f.lastHttpStatus === 200);
  const candidates = healthy.length > 0 ? healthy : feeds;

  // Score candidates: prefer exact title match, then high episode count
  const nameLower = podcastName.toLowerCase().trim();
  let best = candidates[0];
  let bestScore = -1;

  for (const feed of candidates) {
    let score = 0;
    const titleLower = feed.title.toLowerCase().trim();

    if (titleLower === nameLower) {
      score += 100;
    } else if (titleLower.includes(nameLower) || nameLower.includes(titleLower)) {
      score += 50;
    }

    score += Math.min(feed.episodeCount || 0, 50);

    if (score > bestScore) {
      bestScore = score;
      best = feed;
    }
  }

  const episodeCount = best.episodeCount || 0;
  console.log(
    `PodcastIndex: "${podcastName}" → "${best.title}" (${best.url}, http=${best.lastHttpStatus}, eps=${episodeCount})`,
  );

  // Skip podcasts with very few episodes — likely too niche or brand new
  if (episodeCount < 20) {
    console.warn(
      `Dropping "${podcastName}": too few episodes (${episodeCount} < 20 minimum)`,
    );
    return null;
  }

  return { rssUrl: best.url, title: best.title };
}

/**
 * Call OpenAI Responses API with web_search to discover events and podcasts.
 * Then resolve RSS URLs via PodcastIndex in a deterministic post-processing step.
 */
async function runDiscoveryLlm(
  systemPrompt: string,
  recentContext: string,
): Promise<DiscoveryResult> {
  const tools: OpenAI.Responses.Tool[] = [
    { type: 'web_search_preview' },
  ];

  const userMessage =
    `You are a podcast discovery assistant.\n\n` +
    `## Your Task\n${systemPrompt}${recentContext}\n\n` +
    `## Instructions\n` +
    `- Search the web to discover the stories/events described above.\n` +
    `- For each story, search the web to find podcasts that have recently discussed it.\n` +
    `- Strongly prefer well-known, established podcasts with large audiences and long track records. ` +
    `Think major network shows, not indie or niche AI-only podcasts.\n` +
    `- Use the exact episode title as published — do not paraphrase or invent titles.\n` +
    `- Include the podcast host or network name in podcastHost for disambiguation.\n` +
    `- Link each podcast to exactly one event via relatedEvent (must match an events[].name exactly).`;

  const response = await openai.responses.create({
    model: 'gpt-5-mini',
    input: userMessage,
    tools,
    text: {
      format: {
        type: 'json_schema' as const,
        name: 'discovery_result',
        schema: discoveryResultSchema,
        strict: true,
      },
    },
  });

  const textOutput = response.output_text || '';
  if (!textOutput) {
    throw new Error('LLM returned empty output');
  }

  const llmResult = JSON.parse(textOutput) as LlmDiscoveryResult;
  console.log(
    `LLM returned ${llmResult.events.length} events, ${llmResult.podcasts.length} podcasts (pre-RSS resolution)`,
  );

  // Resolve RSS URLs via PodcastIndex for each podcast
  const resolvedPodcasts: DiscoveredPodcast[] = [];
  for (const podcast of llmResult.podcasts) {
    try {
      const resolved = await resolveRssUrl(podcast.podcastName, podcast.podcastHost);
      if (!resolved) {
        console.warn(`Dropping "${podcast.podcastName}": no PodcastIndex match`);
        continue;
      }

      resolvedPodcasts.push({
        podcastName: podcast.podcastName,
        rssUrl: resolved.rssUrl,
        episodeTitle: podcast.episodeTitle,
        episodeDescription: podcast.episodeDescription,
        publishedDate: podcast.publishedDate,
        relatedEvent: podcast.relatedEvent,
        podcastHost: podcast.podcastHost,
      });
    } catch (err) {
      console.warn(`PodcastIndex error for "${podcast.podcastName}": ${err}`);
    }
  }

  console.log(
    `RSS resolution: ${resolvedPodcasts.length}/${llmResult.podcasts.length} podcasts matched`,
  );

  return {
    events: llmResult.events,
    podcasts: resolvedPodcasts,
  };
}

// ─── Single prompt run ────────────────────────────────────────────────────────

async function runPrompt(promptRecord: DiscoveryPromptRecord): Promise<PromptRunResult> {
  console.log(`Starting discovery run for prompt: ${promptRecord.name} (${promptRecord.id})`);

  const startedAt = new Date().toISOString();
  let episodesDiscovered = 0;
  let topicSeedsCreated = 0;
  let seriesCreated = 0;
  let discoveryResult: DiscoveryResult | null = null;
  let runError: string | undefined;

  try {
    // Build context about recently discovered events to reduce duplicates
    const recentContext = await buildRecentEventsContext();

    // Run the LLM + resolve RSS URLs via PodcastIndex
    discoveryResult = await runDiscoveryLlm(promptRecord.prompt, recentContext);

    // Generate a pseudo run-id for topic source tracing
    const runId = `${promptRecord.id}-${Date.now()}`;

    // Seed topics in Graphiti for each event
    for (const event of discoveryResult.events) {
      const created = await seedTopic(event, runId);
      if (created) topicSeedsCreated++;
    }

    // Process each podcast
    for (const podcast of discoveryResult.podcasts) {
      try {
        // Validate the RSS URL is reachable before creating anything
        try {
          const headRes = await fetch(podcast.rssUrl, { method: 'HEAD', redirect: 'follow' });
          if (!headRes.ok) {
            console.warn(
              `Skipping "${podcast.podcastName}": RSS URL returned ${headRes.status} — ${podcast.rssUrl}`,
            );
            continue;
          }
        } catch (fetchErr) {
          console.warn(
            `Skipping "${podcast.podcastName}": RSS URL unreachable — ${podcast.rssUrl}: ${fetchErr}`,
          );
          continue;
        }

        // Upsert the series (autoIngest=false)
        const { id: seriesId, created, imageUrl } = await upsertSeries(podcast.rssUrl);
        if (created) {
          seriesCreated++;
          if (imageUrl) {
            await enqueueImageDownload('series', seriesId, imageUrl);
            console.log(`Enqueued series image download for "${podcast.podcastName}"`);
          }
        }

        // Find the matching episode in the RSS feed
        const matchedEp = await matchEpisode(podcast.rssUrl, podcast, {
          windowHours: 168,
          scoreThreshold: 0.5,
          relatedEvent: podcast.relatedEvent,
        });

        if (!matchedEp) {
          console.warn(
            `No RSS episode match for "${podcast.episodeTitle}" in ${podcast.rssUrl}. ` +
            `LLM claimed date: ${podcast.publishedDate ?? 'unknown'}. ` +
            `This may indicate a hallucinated episode title.`,
          );
          continue;
        }

        // Dedup by guid
        const existingId = await findExistingEpisode(seriesId, matchedEp.guid);
        if (existingId) {
          console.log(
            `Episode already exists (guid=${matchedEp.guid}), skipping: ${matchedEp.title}`,
          );
          continue;
        }

        // Create the episode
        const episodeId = await createEpisode(seriesId, matchedEp);
        episodesDiscovered++;

        // Enqueue for audio download
        await enqueueAudioDownload(episodeId);
        console.log(`Enqueued episode: ${matchedEp.title} (${episodeId})`);
      } catch (podcastErr) {
        console.error(`Error processing podcast "${podcast.podcastName}":`, podcastErr);
      }
    }

    console.log(
      `Prompt "${promptRecord.name}" complete: ` +
        `${episodesDiscovered} episodes, ${topicSeedsCreated} seeds, ${seriesCreated} series`,
    );
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
    console.error(`Prompt "${promptRecord.name}" failed:`, err);
  }

  // Log the run result to Narrows (best-effort — don't fail the Lambda if this fails)
  try {
    await narrowsPost('/api/v1/internal/discovery', {
      promptId: promptRecord.id,
      status: runError ? 'failed' : 'complete',
      episodesDiscovered,
      topicSeedsCreated,
      seriesCreated,
      llmResponse: discoveryResult,
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

/**
 * Determine which prompts to run based on message and schedule.
 */
async function getPromptsToRun(message: DiscoveryMessage): Promise<DiscoveryPromptRecord[]> {
  const result = await narrowsGet<{ data: DiscoveryPromptRecord[] }>(
    '/api/v1/discovery/prompts?isActive=true',
  );
  const allActive = result.data || [];

  if (message.promptId) {
    // Specific prompt requested (e.g. manual trigger)
    return allActive.filter((p) => p.id === message.promptId);
  }

  // Filter by schedule: only run prompts whose scheduleMinutes have elapsed since lastRunAt
  const now = Date.now();
  return allActive.filter((p) => {
    if (!p.lastRunAt) return true;
    const lastRun = new Date(p.lastRunAt).getTime();
    const elapsedMinutes = (now - lastRun) / 60_000;
    return elapsedMinutes >= p.scheduleMinutes;
  });
}

/**
 * SQS handler — triggered by a { promptId? } message on the discovery queue,
 * or directly by EventBridge cron (which passes a ScheduledEvent).
 */
export const main: Handler = async (event: SQSEvent | ScheduledEvent) => {
  // Parse message — could be SQS or EventBridge scheduled event
  let message: DiscoveryMessage = {};

  if ('Records' in event && event.Records?.length > 0) {
    try {
      message = JSON.parse(event.Records[0].body) as DiscoveryMessage;
    } catch {
      console.warn('Could not parse SQS message body; running all active prompts');
    }
  }
  // EventBridge scheduled event has no body — runs all active prompts

  const prompts = await getPromptsToRun(message);

  if (prompts.length === 0) {
    console.log('No prompts due to run at this time');
    return { status: 'ok', promptsRun: 0 };
  }

  console.log(`Running ${prompts.length} discovery prompt(s)`);

  // Run prompts sequentially to avoid hammering external APIs
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
