import type { SQSEvent, SQSHandler } from "aws-lambda";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { rssParser as parser } from "../shared/rss-parser";

const sqsClient = new SQSClient({});

interface SeriesData {
  id: string;
  rss_url: string;
  episode_cutoff_date: string;
  title?: string;
  image_url?: string;
  icon_media_id?: string | null;
}

interface RssRefreshMessage {
  seriesId: string;
}

interface SyncResultItem {
  id: string;
  guid: string;
  processingStatus: string | null;
  imageMediaId: string | null;
}

interface SyncResponse {
  data: {
    created: SyncResultItem[];
    existing: SyncResultItem[];
  };
}

/**
 * Extract the image href from an itunes:image XML object.
 * rss-parser returns { $: { href: '...' } } for <itunes:image href="..." />.
 */
export function getItunesImageHref(itunesImage: unknown): string | undefined {
  if (!itunesImage || typeof itunesImage !== "object") return undefined;
  const img = itunesImage as { $?: { href?: string }; href?: string };
  return img.$?.href || img.href;
}

/**
 * Heuristic: does a URL plausibly point to an image rather than a webpage?
 */
export function looksLikeImageUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith("/")) return false;
    const webExts = [".html", ".htm", ".php", ".asp", ".aspx", ".jsp"];
    return !webExts.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

/**
 * Pick the best image URL, preferring itunes:image when it looks like an
 * actual image URL, falling back to the standard RSS <image><url>.
 */
export function pickBestImageUrl(
  itunesImageData: unknown,
  rssImageUrl: string | undefined
): string | undefined {
  const itunesUrl = getItunesImageHref(itunesImageData);
  if (itunesUrl && looksLikeImageUrl(itunesUrl)) return itunesUrl;
  return rssImageUrl;
}

/**
 * Parse duration string (HH:MM:SS or MM:SS or seconds) to seconds
 */
export function parseDuration(duration: string | undefined): number | null {
  if (!duration) return null;

  if (/^\d+$/.test(duration)) {
    return parseInt(duration, 10);
  }

  const parts = duration.split(":").map((p) => parseInt(p, 10));
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  return null;
}

/**
 * Extract owner info from iTunes owner structure
 */
export function extractOwner(owner: unknown): { name?: string; email?: string } {
  if (!owner || typeof owner !== "object") return {};
  const ownerObj = owner as {
    "itunes:name"?: string | string[];
    "itunes:email"?: string | string[];
  };
  const getName = (val: string | string[] | undefined): string | undefined => {
    if (Array.isArray(val)) return val[0];
    return val;
  };
  return {
    name: getName(ownerObj["itunes:name"]),
    email: getName(ownerObj["itunes:email"]),
  };
}

/**
 * Extract categories from iTunes category structure (supports nested categories)
 */
export function extractCategories(itunesCategories: unknown[] | undefined): string[] {
  const categories: string[] = [];
  if (!itunesCategories || !Array.isArray(itunesCategories)) return categories;

  for (const cat of itunesCategories) {
    if (typeof cat === "string") {
      categories.push(cat);
    } else if (typeof cat === "object" && cat !== null) {
      const catObj = cat as {
        $?: { text?: string };
        _?: string;
        "itunes:category"?: unknown[];
      };
      if (catObj.$?.text) {
        categories.push(catObj.$.text);
      } else if (catObj._) {
        categories.push(catObj._);
      }
      if (catObj["itunes:category"]) {
        const subCategories = extractCategories(catObj["itunes:category"]);
        categories.push(...subCategories);
      }
    }
  }
  return categories;
}

async function fetchSeries(seriesId: string): Promise<SeriesData | null> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  if (!apiUrl || !apiKey) {
    throw new Error("NARROWS_API_URL and NARROWS_API_KEY must be set");
  }

  const response = await fetch(`${apiUrl}/api/v1/series/${seriesId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Failed to fetch series: ${response.statusText}`);
  }

  const { data } = await response.json();
  return data as SeriesData;
}

async function updateSeriesFromFeed(
  seriesId: string,
  feedData: Record<string, unknown>
): Promise<void> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  const response = await fetch(`${apiUrl}/api/v1/series/${seriesId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(feedData),
  });

  if (!response.ok) {
    console.warn(`Failed to update series ${seriesId}: ${response.statusText}`);
  }
}

/**
 * Batch-sync episodes via the Narrows /episodes/sync endpoint.
 * Replaces the per-episode upsert loop with a single HTTP call.
 */
async function syncEpisodes(
  seriesId: string,
  episodes: Record<string, unknown>[]
): Promise<SyncResponse> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  const response = await fetch(
    `${apiUrl}/api/v1/series/${seriesId}/episodes/sync`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ episodes }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Episode sync failed (${response.status}): ${text}`);
  }

  return (await response.json()) as SyncResponse;
}

/**
 * Send SQS messages in batches of 10 (the SendMessageBatch limit).
 */
async function sendSqsBatch(
  queueUrl: string,
  messages: { id: string; body: string }[]
): Promise<void> {
  for (let i = 0; i < messages.length; i += 10) {
    const batch = messages.slice(i, i + 10);
    await sqsClient.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((m) => ({
          Id: m.id,
          MessageBody: m.body,
        })),
      })
    );
  }
}

/**
 * Fetch RSS Lambda
 *
 * Consumes from rss-refresh-queue.
 * 1. Fetches series info (1 API call)
 * 2. Parses RSS feed (local)
 * 3. Updates series metadata (1 API call)
 * 4. Batch-syncs all episodes (1 API call)
 * 5. Enqueues audio/image downloads via SQS batch sends
 */
export const main: SQSHandler = async (event: SQSEvent) => {
  console.log(`Processing ${event.Records.length} RSS refresh message(s)`);

  for (const record of event.Records) {
    const message: RssRefreshMessage = JSON.parse(record.body);
    const { seriesId } = message;
    console.log(`Processing RSS refresh for series: ${seriesId}`);

    try {
      const series = await fetchSeries(seriesId);
      if (!series) {
        console.error(`Series not found: ${seriesId}`);
        continue;
      }

      if (!series.rss_url) {
        console.error(`Series ${seriesId} has no RSS URL`);
        continue;
      }

      // Parse RSS feed
      console.log(`Fetching RSS feed: ${series.rss_url}`);
      const feed = await parser.parseURL(series.rss_url);
      console.log(`Found ${feed.items.length} items in feed`);

      // Update series metadata
      const owner = extractOwner(feed.itunesOwner);
      const categories = extractCategories(feed.itunesCategories as unknown[] | undefined);
      const itunesType = feed.itunesType as string | undefined;
      const seriesType = itunesType === "serial" ? "serial" : "episodic";
      const seriesImageUrl = pickBestImageUrl(feed.itunesImage, feed.image?.url);

      await updateSeriesFromFeed(seriesId, {
        title: feed.title || series.title,
        description: feed.description || (feed.itunesSummary as string | undefined),
        subtitle: feed.itunesSubtitle as string | undefined,
        author: feed.itunesAuthor as string | undefined,
        ownerName: owner.name,
        ownerEmail: owner.email,
        language: feed.language as string | undefined,
        imageUrl: seriesImageUrl,
        websiteUrl: feed.link,
        categories: categories.length > 0 ? categories : undefined,
        explicit:
          (feed.itunesExplicit as string) === "yes" ||
          (feed.itunesExplicit as string) === "true",
        copyright: feed.copyright as string | undefined,
        seriesType,
        lastBuildDate: feed.lastBuildDate as string | undefined,
        lastFetchedAt: new Date().toISOString(),
      });

      // Filter episodes by cutoff date and build batch payload
      const cutoffDate = new Date(series.episode_cutoff_date);
      const episodeBatch: Record<string, unknown>[] = [];

      for (const item of feed.items) {
        const pubDate = item.pubDate ? new Date(item.pubDate) : null;
        if (pubDate && pubDate < cutoffDate) continue;

        const enclosure = item.enclosure;
        episodeBatch.push({
          guid: item.guid || item.link || item.title || "",
          title: item.title || "Untitled Episode",
          description: item.contentSnippet || item.content,
          enclosureUrl: enclosure?.url,
          enclosureType: enclosure?.type,
          enclosureLength: enclosure?.length != null ? Number(enclosure.length) : undefined,
          link: item.link,
          imageUrl: pickBestImageUrl(item.itunesImage, undefined),
          duration: parseDuration(item.itunesDuration as string | undefined) ?? undefined,
          publishedAt: pubDate?.toISOString(),
          episodeNumber: item.itunesEpisode ? parseInt(item.itunesEpisode as string, 10) : undefined,
          seasonNumber: item.itunesSeason ? parseInt(item.itunesSeason as string, 10) : undefined,
          episodeType: (item.itunesEpisodeType as string) || "full",
          explicit: (item.itunesExplicit as string) === "yes",
        });
      }

      if (episodeBatch.length === 0) {
        console.log("No episodes after cutoff filter");
        continue;
      }

      // Single API call to sync all episodes
      console.log(`Syncing ${episodeBatch.length} episodes...`);
      const syncResult = await syncEpisodes(seriesId, episodeBatch);

      const { created, existing } = syncResult.data;
      console.log(`Sync complete: ${created.length} created, ${existing.length} existing`);

      // Enqueue audio downloads for new episodes + pending existing ones
      const audioQueueUrl = process.env.AUDIO_DOWNLOAD_QUEUE_URL;
      if (audioQueueUrl) {
        const episodeGuidsWithEnclosure = new Set(
          episodeBatch
            .filter((ep) => ep.enclosureUrl)
            .map((ep) => ep.guid as string)
        );

        const toDownload = [
          ...created.filter((ep) => episodeGuidsWithEnclosure.has(ep.guid)),
          ...existing.filter(
            (ep) =>
              ep.processingStatus === "pending" &&
              episodeGuidsWithEnclosure.has(ep.guid)
          ),
        ];

        if (toDownload.length > 0) {
          await sendSqsBatch(
            audioQueueUrl,
            toDownload.map((ep, i) => ({
              id: `audio-${i}`,
              body: JSON.stringify({ episodeId: ep.id }),
            }))
          );
          console.log(`Enqueued ${toDownload.length} episodes for audio download`);
        }
      }

      // Enqueue image downloads for episodes without an imageMediaId
      const imageQueueUrl = process.env.IMAGE_DOWNLOAD_QUEUE_URL;
      if (imageQueueUrl) {
        const episodeImageMap = new Map(
          episodeBatch
            .filter((ep) => ep.imageUrl)
            .map((ep) => [ep.guid as string, ep.imageUrl as string])
        );

        const allEpisodes = [...created, ...existing];
        const needsImage = allEpisodes.filter(
          (ep) => !ep.imageMediaId && episodeImageMap.has(ep.guid)
        );

        if (needsImage.length > 0) {
          await sendSqsBatch(
            imageQueueUrl,
            needsImage.map((ep, i) => ({
              id: `img-${i}`,
              body: JSON.stringify({
                type: "episode",
                id: ep.id,
                imageUrl: episodeImageMap.get(ep.guid),
              }),
            }))
          );
          console.log(`Enqueued ${needsImage.length} episodes for image download`);
        }

        // Series image download if needed
        if (
          seriesImageUrl &&
          (!series.icon_media_id || seriesImageUrl !== series.image_url)
        ) {
          await sendSqsBatch(imageQueueUrl, [
            {
              id: "series-img",
              body: JSON.stringify({
                type: "series",
                id: seriesId,
                imageUrl: seriesImageUrl,
              }),
            },
          ]);
          console.log(`Enqueued series image download: ${seriesImageUrl}`);
        }
      }
    } catch (error) {
      console.error(`Error processing series ${seriesId}:`, error);
      throw error;
    }
  }
};
