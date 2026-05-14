import { createHash } from 'crypto';

export interface PodcastFeed {
  id: number;
  title: string;
  url: string;
  originalUrl: string;
  link: string;
  description: string;
  author: string;
  ownerName: string;
  image: string;
  artwork: string;
  itunesId: number | null;
  dead: number;
  lastHttpStatus: number;
  episodeCount?: number;
}

export interface PodcastSearchResult {
  feeds: PodcastFeed[];
  query: string;
  count: number;
}

/**
 * Search PodcastIndex.org for podcasts matching a query.
 * Returns non-dead feeds sorted by relevance.
 *
 * Authentication uses HMAC-SHA1 with timestamp as required by PodcastIndex API.
 */
export async function findPodcastRss(query: string): Promise<PodcastFeed[]> {
  const apiKey = process.env.PODCASTINDEX_API_KEY;
  const apiSecret = process.env.PODCASTINDEX_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error('PODCASTINDEX_API_KEY and PODCASTINDEX_API_SECRET are required');
  }

  const authTime = Math.floor(Date.now() / 1000);
  const authHash = createHash('sha1')
    .update(`${apiKey}${apiSecret}${authTime}`)
    .digest('hex');

  const url = `https://api.podcastindex.org/api/1.0/search/byterm?q=${encodeURIComponent(query)}&max=10`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'X-Auth-Key': apiKey,
        'X-Auth-Date': String(authTime),
        Authorization: authHash,
        'User-Agent': 'Audiopond/1.0',
      },
    });
  } catch (fetchErr) {
    const cause = fetchErr instanceof Error ? (fetchErr.cause ?? fetchErr.message) : fetchErr;
    throw new Error(
      `PodcastIndex fetch failed for "${query}"\n` +
      `  URL: ${url}\n` +
      `  Cause: ${cause}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '(could not read body)');
    throw new Error(
      `PodcastIndex API error: ${response.status} ${response.statusText}\n` +
      `  URL: ${url}\n` +
      `  Auth-Key: ${apiKey.slice(0, 6)}…\n` +
      `  Auth-Date: ${authTime}\n` +
      `  Response body: ${body}`,
    );
  }

  const data = (await response.json()) as PodcastSearchResult;
  return (data.feeds || []).filter((f) => f.dead === 0);
}

/**
 * OpenAI tool definition for find_podcast_rss.
 * The LLM calls this to look up RSS feeds by podcast name.
 * All non-dead results are returned so the LLM can select the correct one.
 */
export const findPodcastRssTool = {
  type: 'function' as const,
  name: 'find_podcast_rss',
  description:
    'Search for a podcast RSS feed URL by podcast name. ' +
    'Returns a list of matching podcasts including their RSS URLs, titles, and descriptions. ' +
    'Use this after finding a podcast via web search to get its RSS feed URL. ' +
    'Select the best match based on title, author, and description.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The podcast name or host name to search for',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

/**
 * Format PodcastIndex results for the LLM to read.
 * Strips large fields, keeps what's needed for identification.
 */
export function formatFeedsForLlm(feeds: PodcastFeed[]): object[] {
  return feeds.slice(0, 8).map((f) => ({
    title: f.title,
    rssUrl: f.url,
    author: f.author || f.ownerName || '',
    description: f.description?.slice(0, 200) || '',
    itunesId: f.itunesId,
    lastHttpStatus: f.lastHttpStatus,
    episodeCount: f.episodeCount,
  }));
}
