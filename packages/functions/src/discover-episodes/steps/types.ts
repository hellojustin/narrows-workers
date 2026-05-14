import type { MatchedEpisode } from '../match-episode';

export interface Story {
  headline: string;
  summary: string;
}

export interface PodcastResult {
  headline: string;
  podcast_title: string;
  episode_title: string;
  episode_desc: string;
  published_at: string;
}

export interface ResolvedPodcast extends PodcastResult {
  rss_url: string | null;
  rss_title: string | null;
  episode_count: number | null;
  drop_reason: string | null;
}

export interface MatchedPodcast extends ResolvedPodcast {
  rss_url: string;
  matched_guid: string;
  matched_title: string;
  match_score: number;
  episode_data: MatchedEpisode;
}

export interface IngestResult {
  episodesDiscovered: number;
  seriesCreated: number;
  ingestedHeadlines: string[];
}
