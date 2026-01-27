import type { SQSEvent, SQSHandler } from "aws-lambda";

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
    const { seriesId } = JSON.parse(record.body);
    console.log(`Processing RSS refresh for series: ${seriesId}`);

    // TODO: Implement RSS fetching and episode creation
    // 1. Fetch series from database by ID
    // 2. Fetch RSS feed from series.rssUrl
    // 3. Parse episodes using rss-parser
    // 4. For each episode with publishedAt >= episodeCutoffDate:
    //    - Create or update Episode record (match by guid)
    //    - Set processingStatus = 'pending'
    // 5. Enqueue episode IDs to audio-download-queue
    // 6. Update series.lastFetchedAt
  }
};
