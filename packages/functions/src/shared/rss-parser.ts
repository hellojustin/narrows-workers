import Parser from 'rss-parser';

/**
 * Shared RSS parser instance with all custom iTunes/podcast namespace fields.
 * Used by fetch-rss, discover-episodes, and validate-feed.
 */
export const rssParser = new Parser({
  customFields: {
    item: [
      ['itunes:duration', 'itunesDuration'],
      ['itunes:episode', 'itunesEpisode'],
      ['itunes:season', 'itunesSeason'],
      ['itunes:episodeType', 'itunesEpisodeType'],
      ['itunes:explicit', 'itunesExplicit'],
      ['itunes:image', 'itunesImage', { keepArray: false }],
      ['itunes:author', 'itunesAuthor'],
    ],
    feed: [
      ['itunes:author', 'itunesAuthor'],
      ['itunes:owner', 'itunesOwner'],
      ['itunes:image', 'itunesImage', { keepArray: false }],
      ['itunes:explicit', 'itunesExplicit'],
      ['itunes:category', 'itunesCategories', { keepArray: true }],
      ['itunes:type', 'itunesType'],
      ['itunes:subtitle', 'itunesSubtitle'],
      ['itunes:summary', 'itunesSummary'],
      ['language', 'language'],
      ['copyright', 'copyright'],
      ['lastBuildDate', 'lastBuildDate'],
    ] as any,
  },
});
