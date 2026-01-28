import type { SQSEvent, SQSHandler } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import Parser from "rss-parser";

const sqsClient = new SQSClient({});
const parser = new Parser({
  customFields: {
    item: [
      ["itunes:duration", "itunesDuration"],
      ["itunes:episode", "itunesEpisode"],
      ["itunes:season", "itunesSeason"],
      ["itunes:episodeType", "itunesEpisodeType"],
      ["itunes:explicit", "itunesExplicit"],
      ["itunes:image", "itunesImage", { keepArray: false }],
      ["itunes:author", "itunesAuthor"],
    ],
    feed: [
      ["itunes:author", "itunesAuthor"],
      ["itunes:owner", "itunesOwner"],
      ["itunes:image", "itunesImage", { keepArray: false }],
      ["itunes:explicit", "itunesExplicit"],
      ["itunes:category", "itunesCategories", { keepArray: true }],
      ["itunes:type", "itunesType"],
      ["itunes:subtitle", "itunesSubtitle"],
      ["itunes:summary", "itunesSummary"],
      ["language", "language"],
      ["copyright", "copyright"],
      ["lastBuildDate", "lastBuildDate"],
    ],
  },
});

interface SeriesData {
  id: string;
  rssUrl: string;
  episodeCutoffDate: string;
  title?: string;
  imageUrl?: string;
  imageMediaId?: string | null;
}

interface RssRefreshMessage {
  seriesId: string;
}

/**
 * Parse duration string (HH:MM:SS or MM:SS or seconds) to seconds
 */
function parseDuration(duration: string | undefined): number | null {
  if (!duration) return null;

  // If it's already a number, return it
  if (/^\d+$/.test(duration)) {
    return parseInt(duration, 10);
  }

  // Parse HH:MM:SS or MM:SS format
  const parts = duration.split(":").map((p) => parseInt(p, 10));
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  return null;
}

/**
 * Fetch series data from Narrows API
 */
async function fetchSeries(seriesId: string): Promise<SeriesData | null> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  if (!apiUrl || !apiKey) {
    throw new Error("NARROWS_API_URL and NARROWS_API_KEY must be set");
  }

  const response = await fetch(`${apiUrl}/api/v1/series/${seriesId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch series: ${response.statusText}`);
  }

  const { data } = await response.json();
  return data as SeriesData;
}

/**
 * Extract owner info from iTunes owner structure
 */
function extractOwner(owner: unknown): { name?: string; email?: string } {
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
function extractCategories(itunesCategories: unknown[] | undefined): string[] {
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
      // Get nested subcategories
      if (catObj["itunes:category"]) {
        const subCategories = extractCategories(catObj["itunes:category"]);
        categories.push(...subCategories);
      }
    }
  }
  return categories;
}

/**
 * Update series with ALL feed metadata
 */
async function updateSeriesFromFeed(
  seriesId: string,
  feedData: {
    title?: string;
    description?: string;
    subtitle?: string;
    author?: string;
    ownerName?: string;
    ownerEmail?: string;
    language?: string;
    imageUrl?: string;
    websiteUrl?: string;
    categories?: string[];
    explicit?: boolean;
    copyright?: string;
    seriesType?: string;
    lastBuildDate?: string;
    lastFetchedAt?: string;
  }
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
 * Create or update episode via Narrows API
 * Returns the existing episode's processingStatus and imageMediaId
 */
async function upsertEpisode(
  seriesId: string,
  episodeData: {
    guid: string;
    title: string;
    description?: string;
    enclosureUrl?: string;
    enclosureType?: string;
    enclosureLength?: number;
    link?: string;
    imageUrl?: string;
    duration?: number;
    publishedAt?: string;
    episodeNumber?: number;
    seasonNumber?: number;
    episodeType?: string;
    explicit?: boolean;
  }
): Promise<{ id: string; created: boolean; processingStatus: string; imageMediaId: string | null }> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  // First, check if episode exists by guid
  const searchResponse = await fetch(
    `${apiUrl}/api/v1/series/${seriesId}/episodes?guid=${encodeURIComponent(episodeData.guid)}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );

  let episodeId: string;
  let created = false;
  let processingStatus = "pending";
  let imageMediaId: string | null = null;

  if (searchResponse.ok) {
    const { data } = await searchResponse.json();
    if (data && data.length > 0) {
      // Episode already exists - DO NOT update processingStatus
      // Only update metadata fields (title, description, etc.)
      episodeId = data[0].id;
      processingStatus = data[0].processingStatus || "pending";
      imageMediaId = data[0].imageMediaId || null;
      
      // Update metadata only (exclude processingStatus to preserve existing state)
      const { ...metadataOnly } = episodeData;
      await fetch(`${apiUrl}/api/v1/episodes/${episodeId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(metadataOnly),
      });
    } else {
      // Create new episode with pending status
      const createResponse = await fetch(`${apiUrl}/api/v1/series/${seriesId}/episodes`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...episodeData,
          processingStatus: "pending",
        }),
      });
      const result = await createResponse.json();
      episodeId = result.data.id;
      created = true;
      processingStatus = "pending";
      imageMediaId = null;
    }
  } else {
    throw new Error(`Failed to search episodes: ${searchResponse.statusText}`);
  }

  return { id: episodeId, created, processingStatus, imageMediaId };
}

/**
 * Enqueue episode for audio download
 */
async function enqueueAudioDownload(episodeId: string): Promise<void> {
  const queueUrl = process.env.AUDIO_DOWNLOAD_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("AUDIO_DOWNLOAD_QUEUE_URL must be set");
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ episodeId }),
    })
  );
}

/**
 * Enqueue image for download (series or episode artwork)
 */
async function enqueueImageDownload(
  type: "series" | "episode",
  id: string,
  imageUrl: string
): Promise<void> {
  const queueUrl = process.env.IMAGE_DOWNLOAD_QUEUE_URL;
  if (!queueUrl) {
    console.warn("IMAGE_DOWNLOAD_QUEUE_URL not configured, skipping image download");
    return;
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ type, id, imageUrl }),
    })
  );
}

/**
 * Fetch RSS Lambda
 *
 * Consumes from rss-refresh-queue
 * Fetches RSS feed from series.rssUrl
 * Parses episodes and creates/updates Episode records
 * Enqueues episode IDs to audio-download-queue
 */
export const main: SQSHandler = async (event: SQSEvent) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    const message: RssRefreshMessage = JSON.parse(record.body);
    const { seriesId } = message;
    console.log(`Processing RSS refresh for series: ${seriesId}`);

    try {
      // 1. Fetch series from API
      const series = await fetchSeries(seriesId);
      if (!series) {
        console.error(`Series not found: ${seriesId}`);
        continue;
      }

      if (!series.rssUrl) {
        console.error(`Series ${seriesId} has no RSS URL`);
        continue;
      }

      // 2. Fetch and parse RSS feed
      console.log(`Fetching RSS feed: ${series.rssUrl}`);
      const feed = await parser.parseURL(series.rssUrl);
      console.log(`Found ${feed.items.length} items in feed`);

      // 3. Update series metadata from feed with ALL available fields
      const itunesImage = feed.itunesImage as { href?: string } | undefined;
      const owner = extractOwner(feed.itunesOwner);
      const categories = extractCategories(feed.itunesCategories as unknown[] | undefined);
      const itunesType = feed.itunesType as string | undefined;
      const seriesType = itunesType === "serial" ? "serial" : "episodic";

      const seriesImageUrl = itunesImage?.href || feed.image?.url;
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
        explicit: (feed.itunesExplicit as string) === "yes" || 
                  (feed.itunesExplicit as string) === "true",
        copyright: feed.copyright as string | undefined,
        seriesType,
        lastBuildDate: feed.lastBuildDate as string | undefined,
        lastFetchedAt: new Date().toISOString(),
      });

      // 3.5. Enqueue series image download if needed
      if (seriesImageUrl && !series.imageMediaId) {
        await enqueueImageDownload("series", seriesId, seriesImageUrl);
        console.log(`Enqueued series image download: ${seriesImageUrl}`);
      }

      // 4. Process episodes
      const cutoffDate = new Date(series.episodeCutoffDate);
      let processedCount = 0;
      let enqueuedCount = 0;

      for (const item of feed.items) {
        const pubDate = item.pubDate ? new Date(item.pubDate) : null;

        // Skip episodes older than cutoff date
        if (pubDate && pubDate < cutoffDate) {
          console.log(`Skipping episode "${item.title}" - older than cutoff date`);
          continue;
        }

        // Extract enclosure data
        const enclosure = item.enclosure;
        const itunesImage = item.itunesImage as { href?: string } | undefined;

        // Prepare episode data (without processingStatus - that's managed separately)
        const episodeData = {
          guid: item.guid || item.link || item.title || "",
          title: item.title || "Untitled Episode",
          description: item.contentSnippet || item.content,
          enclosureUrl: enclosure?.url,
          enclosureType: enclosure?.type,
          enclosureLength: enclosure?.length ? parseInt(enclosure.length, 10) : undefined,
          link: item.link,
          imageUrl: itunesImage?.href,
          duration: parseDuration(item.itunesDuration as string | undefined),
          publishedAt: pubDate?.toISOString(),
          episodeNumber: item.itunesEpisode ? parseInt(item.itunesEpisode as string, 10) : undefined,
          seasonNumber: item.itunesSeason ? parseInt(item.itunesSeason as string, 10) : undefined,
          episodeType: (item.itunesEpisodeType as string) || "full",
          explicit: (item.itunesExplicit as string) === "yes",
        };

        // Create or update episode (preserves existing processingStatus)
        const { id: episodeId, created, processingStatus, imageMediaId: episodeImageMediaId } = await upsertEpisode(seriesId, episodeData);
        processedCount++;

        // Enqueue for audio download if:
        // 1. Newly created episode with an enclosure URL, OR
        // 2. Existing episode still in 'pending' status (not yet processed)
        const shouldEnqueueAudio = enclosure?.url && (created || processingStatus === "pending");
        if (shouldEnqueueAudio) {
          await enqueueAudioDownload(episodeId);
          enqueuedCount++;
          console.log(`Enqueued episode "${item.title}" for audio download (created: ${created}, status: ${processingStatus})`);
        }

        // Enqueue for image download if episode has an image URL but no imageMediaId
        const episodeImageUrl = itunesImage?.href;
        if (episodeImageUrl && !episodeImageMediaId) {
          await enqueueImageDownload("episode", episodeId, episodeImageUrl);
          console.log(`Enqueued episode "${item.title}" for image download`);
        }
      }

      console.log(
        `Processed ${processedCount} episodes, enqueued ${enqueuedCount} for audio download`
      );
    } catch (error) {
      console.error(`Error processing series ${seriesId}:`, error);
      throw error;
    }
  }
};
