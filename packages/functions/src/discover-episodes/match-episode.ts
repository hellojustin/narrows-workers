import Parser from 'rss-parser';
import { pickBestImageUrl } from '../fetch-rss/handler';
import type { DiscoveredPodcast } from './types';

export interface RssItem {
  guid?: string;
  title?: string;
  contentSnippet?: string;
  content?: string;
  isoDate?: string;
  pubDate?: string;
  enclosure?: { url?: string; type?: string; length?: string };
  itunes?: { duration?: string; image?: string; episode?: string; season?: string };
}

export interface MatchedEpisode {
  guid: string;
  title: string;
  description: string | null;
  enclosureUrl: string | null;
  enclosureType: string | null;
  enclosureLength: number | null;
  publishedAt: Date | null;
  imageUrl: string | null;
  duration: number | null;
  score: number;
}

const rssParser = new Parser({
  customFields: {
    item: [
      ['itunes:image', 'itunesImage'],
      ['itunes:duration', 'itunesDuration'],
      ['itunes:episode', 'itunesEpisode'],
      ['itunes:season', 'itunesSeason'],
      ['itunes:explicit', 'itunesExplicit'],
    ],
  },
});

/**
 * Normalized Levenshtein distance (0 = identical, 1 = completely different).
 */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return 1;

  const matrix: number[][] = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] =
        b[i - 1] === a[j - 1]
          ? matrix[i - 1][j - 1]
          : 1 + Math.min(matrix[i - 1][j - 1], matrix[i - 1][j], matrix[i][j - 1]);
    }
  }

  return matrix[b.length][a.length] / Math.max(a.length, b.length);
}

/**
 * Token overlap score: proportion of shared words between a and b.
 * Range: 0 (no overlap) to 1 (identical token sets).
 */
function tokenOverlap(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean));
  const tokA = tokenize(a);
  const tokB = tokenize(b);
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let shared = 0;
  for (const t of tokA) if (tokB.has(t)) shared++;
  return shared / Math.max(tokA.size, tokB.size);
}

/**
 * Score how well a candidate RSS item matches the LLM's reported episode.
 * Returns a combined score in [0, 1].
 */
function scoreMatch(
  item: RssItem,
  discovered: DiscoveredPodcast,
  windowMs: number,
): number {
  const candidateTitle = item.title || '';
  const targetTitle = discovered.episodeTitle;

  const levScore = 1 - levenshteinDistance(candidateTitle.toLowerCase(), targetTitle.toLowerCase());
  const overlapScore = tokenOverlap(candidateTitle, targetTitle);

  // Average of the two title similarity metrics
  let titleScore = (levScore + overlapScore) / 2;

  // Boost if description text overlaps with the episode description
  let descScore = 0;
  if (discovered.episodeDescription) {
    const candidateDesc = item.contentSnippet || item.content || '';
    descScore = tokenOverlap(candidateDesc, discovered.episodeDescription) * 0.3;
  }

  // Recency: prefer episodes within the recency window, penalize older ones
  let recencyBoost = 0;
  const pubDate = item.isoDate || item.pubDate;
  if (pubDate) {
    const pubMs = new Date(pubDate).getTime();
    const ageMs = Date.now() - pubMs;
    if (ageMs >= 0 && ageMs <= windowMs) {
      recencyBoost = 0.1;
    }
  }

  // If the LLM provided a published date, bonus for items published on the same day
  if (discovered.publishedDate && pubDate) {
    const targetDay = discovered.publishedDate.slice(0, 10);
    const candidateDay = new Date(pubDate).toISOString().slice(0, 10);
    if (targetDay === candidateDay) recencyBoost += 0.1;
  }

  return Math.min(1, titleScore + descScore + recencyBoost);
}

/**
 * Score how well an RSS item's title/description match an event topic.
 * Used as a fallback when the LLM's episode title doesn't match.
 */
function scoreEventMatch(
  item: RssItem,
  eventName: string,
  windowMs: number,
): number {
  const candidateTitle = item.title || '';
  const candidateDesc = item.contentSnippet || item.content || '';
  const combined = `${candidateTitle} ${candidateDesc}`;

  const titleOverlap = tokenOverlap(candidateTitle, eventName);
  const combinedOverlap = tokenOverlap(combined, eventName);
  let score = Math.max(titleOverlap, combinedOverlap * 0.8);

  // Recency boost — strongly prefer recent episodes for event matching
  const pubDate = item.isoDate || item.pubDate;
  if (pubDate) {
    const ageMs = Date.now() - new Date(pubDate).getTime();
    if (ageMs >= 0 && ageMs <= windowMs) {
      score += 0.15;
    }
  }

  return Math.min(1, score);
}

/**
 * Parse an RSS feed and find the episode best matching the LLM's report.
 * Uses a two-pass approach:
 * 1. Try to match by episode title (LLM's claimed title vs actual RSS titles)
 * 2. If that fails and relatedEvent is provided, fall back to matching the
 *    event/topic keywords against RSS titles and descriptions
 *
 * @param rssUrl - RSS feed URL to parse
 * @param discovered - The podcast/episode info returned by the LLM
 * @param options.windowHours - Only consider episodes published within this many hours (default 72)
 * @param options.scoreThreshold - Minimum score to accept a match (default 0.5)
 * @param options.relatedEvent - Event name to use for fallback topic matching
 * @returns The best matching episode, or null if no acceptable match found
 */
export async function matchEpisode(
  rssUrl: string,
  discovered: DiscoveredPodcast,
  options: { windowHours?: number; scoreThreshold?: number; relatedEvent?: string } = {},
): Promise<MatchedEpisode | null> {
  const windowHours = options.windowHours ?? 72;
  const scoreThreshold = options.scoreThreshold ?? 0.5;
  const windowMs = windowHours * 60 * 60 * 1000;

  let feed: Awaited<ReturnType<typeof rssParser.parseURL>>;
  try {
    feed = await rssParser.parseURL(rssUrl);
  } catch (err) {
    throw new Error(`Failed to parse RSS feed ${rssUrl}: ${err}`);
  }

  if (!feed.items || feed.items.length === 0) {
    return null;
  }

  const items = feed.items as RssItem[];
  const recentItems = items.filter((item) => {
    const pubDate = item.isoDate || item.pubDate;
    if (!pubDate) return true;
    const ageMs = Date.now() - new Date(pubDate).getTime();
    return ageMs >= 0 && ageMs <= windowMs;
  });

  const candidates = recentItems.length > 0 ? recentItems : items;

  // Pass 1: Match by episode title
  let bestItem: RssItem | null = null;
  let bestScore = -1;
  const topCandidates: { title: string; score: number }[] = [];

  for (const item of candidates) {
    const score = scoreMatch(item, discovered, windowMs);
    topCandidates.push({ title: item.title || '(untitled)', score });
    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }

  topCandidates.sort((a, b) => b.score - a.score);
  const top5 = topCandidates.slice(0, 5);
  console.log(
    `Episode match for "${discovered.episodeTitle}": best=${bestScore.toFixed(3)}, ` +
    `threshold=${scoreThreshold}, candidates=${candidates.length}, ` +
    `top5=${JSON.stringify(top5.map((c) => `${c.score.toFixed(3)} "${c.title}"`))}`,
  );

  // Pass 2: If title match failed, try matching by event/topic keywords
  if ((!bestItem || bestScore < scoreThreshold) && options.relatedEvent) {
    console.log(`Title match failed, trying event-based fallback for "${options.relatedEvent}"...`);

    let eventBestItem: RssItem | null = null;
    let eventBestScore = -1;
    const eventCandidates: { title: string; score: number }[] = [];

    for (const item of candidates) {
      const score = scoreEventMatch(item, options.relatedEvent, windowMs);
      eventCandidates.push({ title: item.title || '(untitled)', score });
      if (score > eventBestScore) {
        eventBestScore = score;
        eventBestItem = item;
      }
    }

    eventCandidates.sort((a, b) => b.score - a.score);
    const eventTop5 = eventCandidates.slice(0, 5);
    console.log(
      `Event fallback for "${options.relatedEvent}": best=${eventBestScore.toFixed(3)}, ` +
      `top5=${JSON.stringify(eventTop5.map((c) => `${c.score.toFixed(3)} "${c.title}"`))}`,
    );

    if (eventBestItem && eventBestScore >= scoreThreshold) {
      bestItem = eventBestItem;
      bestScore = eventBestScore;
    }
  }

  if (!bestItem || bestScore < scoreThreshold) {
    return null;
  }

  const item = bestItem as RssItem & Record<string, unknown>;
  const enclosure = item.enclosure as { url?: string; type?: string; length?: string } | undefined;
  const pubDate = (item.isoDate as string | undefined) || (item.pubDate as string | undefined);

  const imageUrl = pickBestImageUrl(
    (item as Record<string, unknown>).itunesImage,
    typeof item.imageUrl === 'string' ? item.imageUrl : undefined,
  );

  const durationRaw =
    (item as Record<string, unknown>).itunesDuration as string | undefined;
  let duration: number | null = null;
  if (durationRaw) {
    if (/^\d+$/.test(durationRaw)) {
      duration = parseInt(durationRaw, 10);
    } else {
      const parts = durationRaw.split(':').map(Number);
      if (!parts.some(isNaN)) {
        duration =
          parts.length === 3
            ? parts[0] * 3600 + parts[1] * 60 + parts[2]
            : parts.length === 2
            ? parts[0] * 60 + parts[1]
            : null;
      }
    }
  }

  return {
    guid: (item.guid as string | undefined) || (item.link as string | undefined) || item.title || '',
    title: item.title || '',
    description: (item.contentSnippet as string | undefined) || (item.content as string | undefined) || null,
    enclosureUrl: enclosure?.url || null,
    enclosureType: enclosure?.type || null,
    enclosureLength: enclosure?.length ? parseInt(enclosure.length, 10) : null,
    publishedAt: pubDate ? new Date(pubDate) : null,
    imageUrl: imageUrl || null,
    duration,
    score: bestScore,
  };
}
