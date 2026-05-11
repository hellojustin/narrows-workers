/**
 * Structured output schema returned by the discovery LLM.
 * The model is asked to find current news events and podcast episodes covering them.
 */
export interface DiscoveryResult {
  events: DiscoveredEvent[];
  podcasts: DiscoveredPodcast[];
}

export interface DiscoveredEvent {
  /** Short topic name, 2-8 words. Becomes a TopicSeed in Graphiti. */
  name: string;
  /** 1-3 sentence description of the event/story. */
  description: string;
}

export interface DiscoveredPodcast {
  /** Podcast show name as found via web search. */
  podcastName: string;
  /** RSS feed URL — populated by post-processing via PodcastIndex, not the LLM. */
  rssUrl: string;
  /** Title of the specific episode discussing the event. */
  episodeTitle: string;
  /** Episode description if available. */
  episodeDescription?: string | null;
  /** ISO date string of the episode's publication date, if known. */
  publishedDate?: string | null;
  /** Which event this episode covers (matches events[].name). */
  relatedEvent: string;
  /** Host or network name to help PodcastIndex disambiguation. */
  podcastHost?: string | null;
}

/** SQS message body for the discovery queue */
export interface DiscoveryMessage {
  /** ID of the DiscoveryPrompt to run. If omitted, runs all active prompts. */
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
