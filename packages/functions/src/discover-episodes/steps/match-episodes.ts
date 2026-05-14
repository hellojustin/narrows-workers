import { matchEpisode } from '../match-episode';
import { validateFeed } from '../validate-feed';
import type { DiscoveredPodcast } from '../types';
import type { ResolvedPodcast, MatchedPodcast } from './types';

export async function matchEpisodesInFeeds(podcasts: ResolvedPodcast[]): Promise<MatchedPodcast[]> {
  const withRss = podcasts.filter((p): p is ResolvedPodcast & { rss_url: string } => p.rss_url !== null);
  const skipped = podcasts.length - withRss.length;

  console.log(`Step 4: Matching ${withRss.length} episodes in RSS feeds (${skipped} skipped — no RSS)…`);

  const byRssUrl = new Map<string, (ResolvedPodcast & { rss_url: string })[]>();
  for (const p of withRss) {
    const list = byRssUrl.get(p.rss_url) ?? [];
    list.push(p);
    byRssUrl.set(p.rss_url, list);
  }

  const matched: MatchedPodcast[] = [];

  const feedResults = await Promise.allSettled(
    [...byRssUrl.entries()].map(async ([rssUrl, feedPodcasts]) => {
      const results: MatchedPodcast[] = [];

      for (const p of feedPodcasts) {
        try {
          const headRes = await fetch(rssUrl, { method: 'HEAD', redirect: 'follow' });
          if (!headRes.ok) {
            console.warn(`Skipping "${p.podcast_title}": RSS URL returned ${headRes.status}`);
            continue;
          }
        } catch (fetchErr) {
          console.warn(`Skipping "${p.podcast_title}": RSS URL unreachable — ${fetchErr}`);
          continue;
        }

        const validation = await validateFeed(rssUrl);
        if (!validation.valid) {
          console.warn(`Skipping "${p.podcast_title}": feed validation failed — ${validation.reasons.join('; ')}`);
          continue;
        }

        const discovered: DiscoveredPodcast = {
          podcastName: p.podcast_title,
          rssUrl,
          episodeTitle: p.episode_title,
          episodeDescription: p.episode_desc,
          publishedDate: p.published_at,
          relatedEvent: p.headline,
        };

        const ep = await matchEpisode(rssUrl, discovered, {
          windowHours: 168,
          scoreThreshold: 0.4,
          relatedEvent: p.headline,
        });

        if (!ep) {
          console.warn(
            `No RSS match for "${p.episode_title}" in ${rssUrl}. ` +
            `LLM date: ${p.published_at}. Possibly hallucinated.`,
          );
          continue;
        }

        results.push({
          ...p,
          rss_url: rssUrl,
          matched_guid: ep.guid,
          matched_title: ep.title,
          match_score: ep.score,
          episode_data: ep,
        });
      }

      return results;
    }),
  );

  for (const result of feedResults) {
    if (result.status === 'fulfilled') {
      matched.push(...result.value);
    }
  }

  console.log(`Step 4: ${matched.length} episodes matched, ${withRss.length - matched.length} unmatched`);
  return matched;
}
