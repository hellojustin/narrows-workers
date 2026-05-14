/**
 * Intermediate type used by match-episode.ts to bridge LLM output
 * into the RSS episode matching function.
 */
export interface DiscoveredPodcast {
  podcastName: string;
  rssUrl: string;
  episodeTitle: string;
  episodeDescription?: string | null;
  publishedDate?: string | null;
  relatedEvent: string;
  podcastHost?: string | null;
}

/** SQS message body for the discovery queue */
export interface DiscoveryMessage {
  promptId?: string;
}

/** Result of a single prompt execution */
export interface PromptRunResult {
  promptId: string;
  promptName: string;
  episodesDiscovered: number;
  topicSeedsCreated: number;
  seriesCreated: number;
  error?: string;
}
