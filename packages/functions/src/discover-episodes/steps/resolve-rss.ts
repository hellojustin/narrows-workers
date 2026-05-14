import { findPodcastRss } from '../tools/find-podcast-rss';
import type { PodcastResult, ResolvedPodcast } from './types';

interface RssResolution {
  rssUrl: string;
  title: string;
  episodeCount: number;
}

async function resolveRssUrl(podcastName: string): Promise<RssResolution | { dropReason: string }> {
  const feeds = await findPodcastRss(podcastName);

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

export async function resolveRssUrls(podcasts: PodcastResult[]): Promise<ResolvedPodcast[]> {
  const uniqueNames = [...new Set(podcasts.map((p) => p.podcast_title))];
  console.log(`Step 3: Resolving RSS URLs for ${uniqueNames.length} unique podcasts…`);

  const cache = new Map<string, RssResolution | { dropReason: string }>();

  let found = 0;
  let dropped = 0;

  for (const name of uniqueNames) {
    try {
      const result = await resolveRssUrl(name);
      cache.set(name, result);

      if ('rssUrl' in result) {
        found++;
        console.log(`  ✓ ${name} → ${result.title} (${result.rssUrl}, ${result.episodeCount} eps)`);
      } else {
        dropped++;
        console.log(`  ✗ ${name} → ${result.dropReason}`);
      }
    } catch (err) {
      dropped++;
      const msg = err instanceof Error ? err.message : String(err);
      cache.set(name, { dropReason: msg });
      console.error(`  ✗ ${name} → Error: ${msg}`);
    }
  }

  console.log(`Step 3: ${found} found, ${dropped} dropped`);

  return podcasts.map((p) => {
    const cached = cache.get(p.podcast_title);
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
}
