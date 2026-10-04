import type { Story } from './types';

export interface SeedTopicsDeps {
  graphitiPost<T>(path: string, body: unknown): Promise<T>;
  graphId: string;
  granularity: number;
}

export async function seedTopics(
  stories: Story[],
  ingestedHeadlines: string[],
  runId: string,
  deps: SeedTopicsDeps,
): Promise<number> {
  const headlineSet = new Set(ingestedHeadlines);
  const toSeed = stories.filter((s) => headlineSet.has(s.headline));

  const granularity = deps.granularity;
  console.log(
    `Step 6: Seeding ${toSeed.length} topics at level ${granularity} (${stories.length} stories, ${headlineSet.size} with ingested content)…`,
  );

  let created = 0;

  for (const story of toSeed) {
    try {
      const now = new Date();
      const expireAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const result = await deps.graphitiPost<{ created: boolean }>(
        `/graphs/${deps.graphId}/topics/seeds`,
        {
          name: story.headline,
          description: story.summary,
          granularity,
          source: `discovery-run:${runId}`,
          valid_at: now.toISOString(),
          expire_at: expireAt.toISOString(),
        },
      );
      if (result.created) created++;
    } catch (err) {
      console.warn(`Failed to seed topic "${story.headline}":`, err);
    }
  }

  console.log(`Step 6: ${created} topic seeds created`);
  return created;
}
