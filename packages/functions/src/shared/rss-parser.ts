import Parser from 'rss-parser';
import { POND_BOT_USER_AGENT } from './pond-bot-user-agent';

/**
 * Shared RSS parser instance with all custom iTunes/podcast namespace fields.
 * Used by fetch-rss, discover-episodes, and validate-feed.
 *
 * The User-Agent is set here so every `parseURL` identifies as PondBot,
 * including discovery and feed validation. rss-parser's default is the
 * library name, which hosts treat as unidentified bot traffic.
 */
export const rssParser = new Parser({
  headers: {
    'User-Agent': POND_BOT_USER_AGENT,
  },
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
