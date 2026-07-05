#!/usr/bin/env tsx
/**
 * Discovery prompt tester.
 *
 * Modes:
 *   topics_only — Stage 1 only: discover stories and print topic seeds.
 *   full        — All four stages (default).
 *
 * Stage 1 — Stories (scripts/prompts/stories.txt):
 *   Calls OpenAI to find current news stories via web search.
 *
 * Stage 2 — Podcasts (scripts/prompts/podcasts.txt):
 *   For each story, finds 3-5 podcast episodes (concurrent).
 *   Saves output to scripts/output/stage2.json for re-use.
 *
 * Stage 3 — RSS Lookup:
 *   Resolves each podcast name to an RSS URL via PodcastIndex.
 *
 * Stage 4 — Episode Matching:
 *   Locates each episode in the RSS feed using fuzzy title matching.
 *
 * Usage:
 *   npm run test:prompt -- --mode=topics_only  # stories only (no podcasts/RSS/matching)
 *   npm run test:prompt                        # full run (stages 1-4)
 *   npm run test:prompt -- --from=3            # start at stage 3, load stage 2 output from file
 *   npm run test:prompt -- --raw               # JSON output
 *   npm run test:prompt -- --from=3 --raw
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import OpenAI from 'openai';
import { findPodcastRss } from '../packages/functions/src/discover-episodes/tools/find-podcast-rss';
import { matchEpisode } from '../packages/functions/src/discover-episodes/match-episode';
import type { DiscoveredPodcast } from '../packages/functions/src/discover-episodes/types';

const STORIES_PROMPT_FILE = 'scripts/prompts/stories.txt';
const PODCASTS_PROMPT_FILE = 'scripts/prompts/podcasts.txt';
const STAGE2_OUTPUT_FILE = 'scripts/output/stage2.json';
const MODEL = 'gpt-5.4';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const storiesSchema = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          headline: { type: 'string', description: 'Short news headline (two words max)' },
          summary: { type: 'string', description: 'One or two sentence summary of the story' },
          citation: { type: 'string', description: 'URL of the source citation for the story' },
        },
        required: ['headline', 'summary', 'citation'],
        additionalProperties: false,
      },
    },
  },
  required: ['stories'],
  additionalProperties: false,
} as const;

const podcastsSchema = {
  type: 'object',
  properties: {
    podcasts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          headline: { type: 'string', description: 'The news headline this episode covers' },
          podcast_title: { type: 'string', description: 'Exact podcast show name' },
          episode_title: { type: 'string', description: 'Exact episode title as published' },
          episode_desc: { type: 'string', description: 'Episode description or summary' },
          published_at: { type: 'string', description: 'ISO date (YYYY-MM-DD) the episode was published' },
        },
        required: ['headline', 'podcast_title', 'episode_title', 'episode_desc', 'published_at'],
        additionalProperties: false,
      },
    },
  },
  required: ['podcasts'],
  additionalProperties: false,
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

interface Story {
  headline: string;
  summary: string;
  citation: string;
}

interface PodcastResult {
  headline: string;
  podcast_title: string;
  episode_title: string;
  episode_desc: string;
  published_at: string;
}

interface Stage2Output {
  stories: Story[];
  podcasts: PodcastResult[];
}

interface ResolvedPodcast extends PodcastResult {
  rss_url: string | null;
  rss_title: string | null;
  episode_count: number | null;
  drop_reason: string | null;
}

interface MatchResult extends ResolvedPodcast {
  matched_title: string | null;
  matched_guid: string | null;
  match_score: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readPromptFile(path: string): string {
  return readFileSync(resolve(path), 'utf-8').trim();
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function saveStage2Output(data: Stage2Output): void {
  const outPath = resolve(STAGE2_OUTPUT_FILE);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`\nStage 2 output saved to ${STAGE2_OUTPUT_FILE}\n`);
}

function loadStage2Output(): Stage2Output {
  const outPath = resolve(STAGE2_OUTPUT_FILE);
  try {
    const raw = readFileSync(outPath, 'utf-8');
    return JSON.parse(raw) as Stage2Output;
  } catch {
    console.error(`Could not read ${STAGE2_OUTPUT_FILE}. Run a full pass first (without --from).`);
    process.exit(1);
  }
}

/**
 * Resolve a podcast name to its best RSS URL via PodcastIndex.
 * Mirrors the scoring logic in handler.ts.
 */
async function resolveRssUrl(
  podcastName: string,
): Promise<{ rssUrl: string; title: string; episodeCount: number } | { dropReason: string }> {
  let feeds = await findPodcastRss(podcastName);

  if (feeds.length === 0) {
    return { dropReason: 'No PodcastIndex results' };
  }

  const healthy = feeds.filter((f) => f.lastHttpStatus === 200);
  const candidates = healthy.length > 0 ? healthy : feeds;

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
  if (episodeCount < 20) {
    return { dropReason: `Too few episodes (${episodeCount} < 20)` };
  }

  return { rssUrl: best.url, title: best.title, episodeCount };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const rawFlag = args.includes('--raw');
const modeArg = args.find((a) => a.startsWith('--mode='));
const mode: 'full' | 'topics_only' = modeArg?.split('=')[1] === 'topics_only' ? 'topics_only' : 'full';
const fromArg = args.find((a) => a.startsWith('--from='));
const startStage = fromArg ? parseInt(fromArg.split('=')[1], 10) : 1;

if (startStage < 1 || startStage > 4 || isNaN(startStage)) {
  console.error('--from must be 1, 2, 3, or 4');
  process.exit(1);
}

if (mode === 'topics_only' && (fromArg || startStage > 1)) {
  console.error('--from is not compatible with --mode=topics_only (only Stage 1 runs)');
  process.exit(1);
}

let stories: Story[];
let allPodcasts: PodcastResult[];

if (mode === 'topics_only' || startStage <= 2) {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set. Run via: npm run test:prompt');
    process.exit(1);
  }
}

const openai = (mode === 'topics_only' || startStage <= 2) ? new OpenAI() : null;

// ─── Stage 1: Fetch stories ───────────────────────────────────────────────────

if (startStage <= 1) {
  const storiesPromptText = readPromptFile(STORIES_PROMPT_FILE);

  console.log('\n' + '═'.repeat(60));
  console.log(' STAGE 1: STORIES');
  console.log('═'.repeat(60));
  console.log(`\nPrompt file: ${STORIES_PROMPT_FILE}\n`);
  console.log(storiesPromptText);
  console.log('\n' + '─'.repeat(60));

  // Fetch existing topic seeds from Graphiti to avoid duplicates
  interface SeedEntry { name: string; description: string }
  let existingSeeds: SeedEntry[] = [];
  const graphitiUrl = process.env.GRAPHITI_API_URL;
  const graphitiKey = process.env.GRAPHITI_API_KEY;
  const graphitiGraphId = process.env.GRAPHITI_GRAPH_ID;

  if (graphitiUrl && graphitiGraphId) {
    try {
      const headers: Record<string, string> = {};
      if (graphitiKey) headers['Authorization'] = `Bearer ${graphitiKey}`;

      const seedsRes = await fetch(
        `${graphitiUrl}/graphs/${graphitiGraphId}/topics/seeds?active_only=true&limit=200`,
        { headers },
      );
      if (seedsRes.ok) {
        const { seeds } = (await seedsRes.json()) as { seeds: SeedEntry[] };
        existingSeeds = seeds;
        console.log(`Fetched ${existingSeeds.length} existing topic seeds for exclusion`);
      } else {
        console.warn(`Could not fetch seeds (${seedsRes.status}); proceeding without exclusion`);
      }
    } catch (err) {
      console.warn('Could not fetch seeds; proceeding without exclusion:', err);
    }
  } else {
    console.warn('GRAPHITI_API_URL or GRAPHITI_GRAPH_ID not set; skipping seed exclusion');
  }

  console.log('Calling OpenAI…\n');

  const storiesStart = performance.now();

  const input: Array<{ role: 'developer' | 'system' | 'user'; content: string }> = [
    {
      role: 'system',
      content: [
        'You are a news reporter, tasked with finding the most common',
        'stories that are trending in the area of news that the users asks',
        'you to search for. Each of the stories you find will be structured in',
        'two parts: a headline and a summary. A headline is one or two',
        'words: a proper noun or short noun phrase around which the story centers.',
        'Roughly half your headlines should be a single word, and half should be two words.',
        'Use two words when it adds meaningful specificity (a product name, event name, or qualifier).',
        'Readers already familiar with the story should be able to reconize',
        'the headline, and immediately identify the story it refers to.',
        'A summary is a one or two sentence recap of the facts of the story.',
        'it should read like a short, breaking news story, in the present',
        'tense, answering: who, what, when, where, and why. Downstream',
        'consumers of your response may only see one result at a time,',
        'so do not make cross-references or sequential references between',
        'stories in your summaries.',
      ].join(' '),
    },
  ];

  if (existingSeeds.length > 0) {
    input.push({
      role: 'system',
      content: [
        'The following events have ALREADY been covered in the last 24 hours.',
        'Avoid covering the same underlying event as any of these.',
        'These are internal descriptions only — do NOT use them as examples of good headline format.',
        'Your headlines should still follow the rules above (proper nouns, 1-2 words).',
        'Find genuinely new stories instead.',
        '',
        'Already covered events:',
        ...existingSeeds.map((s) => `- ${s.description}`),
      ].join('\n'),
    });
  }

  input.push({ role: 'user', content: storiesPromptText });

  const storiesResponse = await openai!.responses.create({
    model: MODEL,
    input,
    tools: [{ type: 'web_search_preview', search_context_size: 'medium' }],
    text: {
      format: {
        type: 'json_schema' as const,
        name: 'stories_result',
        schema: storiesSchema,
        strict: true,
      },
    },
  });

  const storiesElapsed = ((performance.now() - storiesStart) / 1000).toFixed(1);
  const storiesOutput = storiesResponse.output_text || '';

  if (!storiesOutput) {
    console.error('Stage 1: model returned empty output.');
    process.exit(1);
  }

  stories = (JSON.parse(storiesOutput) as { stories: Story[] }).stories;

  console.log(`Done in ${storiesElapsed}s — ${stories.length} stories\n`);

  for (const [i, story] of stories.entries()) {
    console.log(`  ${i + 1}. ${story.headline}`);
    console.log(`     ${story.summary}`);
    console.log(`     ${story.citation}\n`);
  }
} else {
  // Load from file
  const loaded = loadStage2Output();
  stories = loaded.stories;
  allPodcasts = loaded.podcasts;
  console.log(`\nLoaded ${stories.length} stories and ${allPodcasts.length} podcasts from ${STAGE2_OUTPUT_FILE}\n`);
}

// ─── topics_only: print results and exit ──────────────────────────────────────

if (mode === 'topics_only') {
  if (rawFlag) {
    console.log(JSON.stringify({ stories }, null, 2));
  } else {
    console.log('═'.repeat(60));
    console.log(' TOPIC SEEDS');
    console.log('═'.repeat(60));
    console.log();
    for (const [i, story] of stories.entries()) {
      console.log(`  ${i + 1}. ${story.headline}`);
      console.log(`     ${story.summary}\n`);
    }
    console.log('─'.repeat(60));
    console.log(` ${stories.length} topic seeds`);
    console.log('─'.repeat(60));
    console.log();
  }
  process.exit(0);
}

// ─── Stage 2: Find podcasts (concurrent) ─────────────────────────────────────

if (startStage <= 2) {
  const podcastsPromptTemplate = readPromptFile(PODCASTS_PROMPT_FILE);

  console.log('═'.repeat(60));
  console.log(' STAGE 2: PODCASTS');
  console.log('═'.repeat(60));
  console.log(`\nPrompt file: ${PODCASTS_PROMPT_FILE}`);
  console.log(`Firing ${stories.length} requests concurrently…\n`);

  const podcastsStart = performance.now();

  const podcastResults = await Promise.allSettled(
    stories.map(async (story): Promise<PodcastResult[]> => {
      const prompt = interpolate(podcastsPromptTemplate, {
        headline: story.headline,
        summary: story.summary,
      });

      const response = await openai!.responses.create({
        model: MODEL,
        input: prompt,
        tools: [{ type: 'web_search_preview', search_context_size: 'low' }],
        text: {
          format: {
            type: 'json_schema' as const,
            name: 'podcasts_result',
            schema: podcastsSchema,
            strict: true,
          },
        },
      });

      const output = response.output_text || '';
      if (!output) throw new Error(`Empty output for story: ${story.headline}`);
      return (JSON.parse(output) as { podcasts: PodcastResult[] }).podcasts;
    }),
  );

  const podcastsElapsed = ((performance.now() - podcastsStart) / 1000).toFixed(1);

  allPodcasts = [];
  for (const [i, result] of podcastResults.entries()) {
    if (result.status === 'fulfilled') {
      allPodcasts.push(...result.value);
    } else {
      console.error(`  Story ${i + 1} failed: ${result.reason}`);
    }
  }

  console.log(`Done in ${podcastsElapsed}s — ${allPodcasts.length} podcasts across ${stories.length} stories\n`);

  saveStage2Output({ stories, podcasts: allPodcasts });
}

// ─── Stage 3: RSS Lookup via PodcastIndex ─────────────────────────────────────

console.log('═'.repeat(60));
console.log(' STAGE 3: RSS LOOKUP (PodcastIndex)');
console.log('═'.repeat(60));

const uniquePodcastNames = [...new Set(allPodcasts!.map((p) => p.podcast_title))];
console.log(`\nLooking up ${uniquePodcastNames.length} unique podcast names…\n`);

const rssStart = performance.now();

const rssCache = new Map<string, { rssUrl: string; title: string; episodeCount: number } | { dropReason: string }>();

let rssFound = 0;
let rssDropped = 0;
let rssErrored = 0;

for (const name of uniquePodcastNames) {
  try {
    const result = await resolveRssUrl(name);
    rssCache.set(name, result);
    if ('rssUrl' in result) {
      rssFound++;
      console.log(`  ✓ ${name}`);
      console.log(`    → ${result.title} (${result.rssUrl}, ${result.episodeCount} eps)`);
    } else {
      rssDropped++;
      console.log(`  ✗ ${name}`);
      console.log(`    → ${result.dropReason}`);
    }
  } catch (err) {
    rssErrored++;
    console.error(`  ✗ ${name}`);
    console.error(`    → Error: ${err instanceof Error ? err.message : err}`);
  }
}

const rssElapsed = ((performance.now() - rssStart) / 1000).toFixed(1);
console.log(`\nDone in ${rssElapsed}s — ${rssFound} found, ${rssDropped} dropped, ${rssErrored} errored\n`);

const resolvedPodcasts: ResolvedPodcast[] = allPodcasts!.map((p) => {
  const cached = rssCache.get(p.podcast_title);
  if (!cached || 'dropReason' in cached) {
    return {
      ...p,
      rss_url: null,
      rss_title: null,
      episode_count: null,
      drop_reason: cached && 'dropReason' in cached ? cached.dropReason : 'PodcastIndex lookup failed',
    };
  }
  return {
    ...p,
    rss_url: cached.rssUrl,
    rss_title: cached.title,
    episode_count: cached.episodeCount,
    drop_reason: null,
  };
});

// ─── Stage 4: Episode Matching ────────────────────────────────────────────────

const withRss = resolvedPodcasts.filter((p) => p.rss_url);
const withoutRss = resolvedPodcasts.filter((p) => !p.rss_url);

console.log('═'.repeat(60));
console.log(' STAGE 4: EPISODE MATCHING');
console.log('═'.repeat(60));
console.log(`\nMatching ${withRss.length} episodes in RSS feeds (${withoutRss.length} skipped — no RSS)…\n`);

const matchStart = performance.now();

const matchResults: MatchResult[] = [];

const byRssUrl = new Map<string, ResolvedPodcast[]>();
for (const p of withRss) {
  const list = byRssUrl.get(p.rss_url!) ?? [];
  list.push(p);
  byRssUrl.set(p.rss_url!, list);
}

const matchSettled = await Promise.allSettled(
  [...byRssUrl.entries()].map(async ([rssUrl, podcasts]) => {
    const results: MatchResult[] = [];

    for (const p of podcasts) {
      const discovered: DiscoveredPodcast = {
        podcastName: p.podcast_title,
        rssUrl,
        episodeTitle: p.episode_title,
        episodeDescription: p.episode_desc,
        publishedDate: p.published_at,
        relatedEvent: p.headline,
      };

      try {
        const matched = await matchEpisode(rssUrl, discovered, {
          windowHours: 168,
          scoreThreshold: 0.4,
          relatedEvent: p.headline,
        });

        results.push({
          ...p,
          matched_title: matched?.title ?? null,
          matched_guid: matched?.guid ?? null,
          match_score: matched?.score ?? null,
        });
      } catch (err) {
        results.push({
          ...p,
          matched_title: null,
          matched_guid: null,
          match_score: null,
          drop_reason: `RSS parse error: ${err instanceof Error ? err.message : err}`,
        });
      }
    }

    return results;
  }),
);

for (const settled of matchSettled) {
  if (settled.status === 'fulfilled') {
    matchResults.push(...settled.value);
  }
}

for (const p of withoutRss) {
  matchResults.push({
    ...p,
    matched_title: null,
    matched_guid: null,
    match_score: null,
  });
}

const matchElapsed = ((performance.now() - matchStart) / 1000).toFixed(1);
const matched = matchResults.filter((r) => r.matched_guid);
const unmatched = matchResults.filter((r) => !r.matched_guid);

console.log(`Done in ${matchElapsed}s — ${matched.length} matched, ${unmatched.length} unmatched\n`);

// ─── Final Report ─────────────────────────────────────────────────────────────

if (rawFlag) {
  console.log(JSON.stringify({ stories, results: matchResults }, null, 2));
  process.exit(0);
}

console.log('═'.repeat(60));
console.log(' FINAL REPORT');
console.log('═'.repeat(60));

for (const story of stories) {
  const eps = matchResults.filter((r) => r.headline === story.headline);
  console.log(`\n  ┌─ ${story.headline}`);

  if (eps.length === 0) {
    console.log(`  │   (no podcasts found)`);
  }

  for (const ep of eps) {
    console.log(`  │`);
    if (ep.matched_guid) {
      console.log(`  ├ ✓ ${ep.podcast_title}`);
      console.log(`  │   LLM Episode:     ${ep.episode_title}`);
      console.log(`  │   Matched Episode:  ${ep.matched_title}`);
      console.log(`  │   GUID:            ${ep.matched_guid}`);
      console.log(`  │   Score:           ${ep.match_score!.toFixed(3)}`);
      if (ep.rss_url) console.log(`  │   RSS:             ${ep.rss_url}`);
    } else if (ep.drop_reason) {
      console.log(`  ├ ✗ ${ep.podcast_title}  [DROPPED: ${ep.drop_reason}]`);
      console.log(`  │   LLM Episode:     ${ep.episode_title}`);
    } else {
      console.log(`  ├ ✗ ${ep.podcast_title}  [NO MATCH]`);
      console.log(`  │   LLM Episode:     ${ep.episode_title}`);
      if (ep.rss_url) console.log(`  │   RSS:             ${ep.rss_url}`);
    }
  }

  console.log(`  └─`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const totalEps = matchResults.length;
const matchedCount = matched.length;
const droppedRss = matchResults.filter((r) => r.drop_reason && !r.rss_url).length;
const noMatch = matchResults.filter((r) => r.rss_url && !r.matched_guid && !r.drop_reason).length;
const errored = matchResults.filter((r) => r.rss_url && r.drop_reason).length;

console.log('\n' + '─'.repeat(60));
console.log(` SUMMARY: ${totalEps} total episodes`);
console.log(`   ✓ ${matchedCount} matched in RSS`);
console.log(`   ✗ ${noMatch} not matched (episode not found in feed)`);
console.log(`   ✗ ${droppedRss} dropped (no RSS URL)`);
if (errored > 0) console.log(`   ✗ ${errored} errored (RSS parse failure)`);
console.log('─'.repeat(60));
console.log();
