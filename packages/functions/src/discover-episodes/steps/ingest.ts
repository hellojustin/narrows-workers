import type { MatchedPodcast, IngestResult } from './types';

export interface IngestDeps {
  upsertSeries(rssUrl: string): Promise<{ id: string; created: boolean; imageUrl: string | null }>;
  findExistingEpisode(seriesId: string, guid: string): Promise<string | null>;
  createEpisode(seriesId: string, data: {
    guid: string;
    title: string;
    description: string | null;
    enclosureUrl: string | null;
    enclosureType: string | null;
    enclosureLength: number | null;
    publishedAt: Date | null;
    imageUrl: string | null;
    duration: number | null;
  }): Promise<string>;
  enqueueAudioDownload(episodeId: string): Promise<void>;
  enqueueImageDownload(type: 'series' | 'episode', id: string, imageUrl: string): Promise<void>;
}

export async function ingestEpisodes(
  matches: MatchedPodcast[],
  deps: IngestDeps,
): Promise<IngestResult> {
  console.log(`Step 5: Ingesting ${matches.length} confirmed episodes…`);

  let episodesDiscovered = 0;
  let seriesCreated = 0;
  const ingestedHeadlines = new Set<string>();

  for (const match of matches) {
    try {
      const { id: seriesId, created, imageUrl } = await deps.upsertSeries(match.rss_url);
      if (created) {
        seriesCreated++;
        if (imageUrl) {
          await deps.enqueueImageDownload('series', seriesId, imageUrl);
          console.log(`Enqueued series image download for "${match.podcast_title}"`);
        }
      }

      const existingId = await deps.findExistingEpisode(seriesId, match.matched_guid);
      if (existingId) {
        console.log(`Episode already exists (guid=${match.matched_guid}), skipping: ${match.matched_title}`);
        continue;
      }

      const episodeId = await deps.createEpisode(seriesId, match.episode_data);
      episodesDiscovered++;

      await deps.enqueueAudioDownload(episodeId);
      console.log(`Enqueued episode: ${match.matched_title} (${episodeId})`);

      ingestedHeadlines.add(match.headline);
    } catch (err) {
      console.error(`Error ingesting "${match.podcast_title}" / "${match.matched_title}":`, err);
    }
  }

  console.log(
    `Step 5: ${episodesDiscovered} episodes ingested, ${seriesCreated} series created, ` +
    `${ingestedHeadlines.size} headlines with content`,
  );

  return {
    episodesDiscovered,
    seriesCreated,
    ingestedHeadlines: [...ingestedHeadlines],
  };
}
