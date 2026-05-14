import type OpenAI from 'openai';
import type { Story, PodcastResult } from './types';

const CONCURRENCY_LIMIT = 5;

const PODCAST_PROMPT_TEMPLATE = `Search the web for 3-5 well-known podcast episodes that have discussed the following
news story in the past 3 days:

Story: {{headline}}
{{summary}}

Requirements:
- Only include episodes published in the last 3 days.
- Use the exact episode title as published — do not paraphrase or invent titles.
- Set headline to exactly: {{headline}}`;

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

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

async function semaphoreMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = { status: 'fulfilled', value: await fn(items[idx]) };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function findPodcasts(stories: Story[], openai: OpenAI): Promise<PodcastResult[]> {
  console.log(`Step 2: Finding podcasts for ${stories.length} stories (concurrency: ${CONCURRENCY_LIMIT})…`);

  const results = await semaphoreMap(stories, CONCURRENCY_LIMIT, async (story) => {
    const prompt = interpolate(PODCAST_PROMPT_TEMPLATE, {
      headline: story.headline,
      summary: story.summary,
    });

    const response = await openai.responses.create({
      model: 'gpt-5.4',
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
  });

  const allPodcasts: PodcastResult[] = [];
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      allPodcasts.push(...result.value);
    } else {
      console.error(`Step 2: Story ${i + 1} ("${stories[i].headline}") failed: ${result.reason}`);
    }
  }

  console.log(`Step 2: Found ${allPodcasts.length} podcasts across ${stories.length} stories`);
  return allPodcasts;
}
