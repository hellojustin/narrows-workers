/**
 * Narrows API client for process-transcript Lambda
 */

import type {
  EpisodeData,
  SeriesData,
  SpeakerData,
  Chapter,
  Segment,
} from './types';

const getApiUrl = () => process.env.NARROWS_API_URL;
const getApiKey = () => process.env.NARROWS_API_KEY;

/**
 * Fetch episode data from Narrows API
 */
export async function fetchEpisode(episodeId: string): Promise<EpisodeData | null> {
  const response = await fetch(`${getApiUrl()}/api/v1/episodes/${episodeId}`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
  });

  if (!response.ok) return null;
  const { data } = await response.json();
  return data as EpisodeData;
}

/**
 * Fetch series data from Narrows API
 */
export async function fetchSeries(seriesId: string): Promise<SeriesData | null> {
  const response = await fetch(`${getApiUrl()}/api/v1/series/${seriesId}`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
  });

  if (!response.ok) return null;
  const { data } = await response.json();
  return data as SeriesData;
}

/**
 * Update episode with speaker data
 */
export async function updateEpisodeSpeakers(
  episodeId: string,
  speakerData: SpeakerData
): Promise<void> {
  await fetch(`${getApiUrl()}/api/v1/episodes/${episodeId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ speakerData }),
  });
}

export interface ReplaceAnalysisResult {
  chaptersCreated: number;
  segmentsCreated: number;
  chaptersRemoved: number;
  segmentsRemoved: number;
}

/**
 * Replace an episode's chapters and segments in one call.
 *
 * Must stay a single request. This endpoint clears the episode's existing rows
 * and writes the new ones inside one transaction holding a lock on the episode,
 * which is what stops two concurrent ingestion passes from both appending their
 * results. Writing chapters and segments separately, or per row as this client
 * used to, reintroduces the duplication in PROD-218.
 */
export async function replaceEpisodeAnalysis(
  episodeId: string,
  chapters: Chapter[],
  segments: Segment[]
): Promise<ReplaceAnalysisResult> {
  const response = await fetch(`${getApiUrl()}/api/v1/episodes/${episodeId}/analysis`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chapters: chapters.map((chapter) => ({
        id: chapter.id,
        type: chapter.type,
        title: chapter.title,
        summary: chapter.summary,
        episodeStartSec: chapter.episodeStartSec,
        episodeEndSec: chapter.episodeEndSec,
      })),
      segments: segments.map((segment) => ({
        id: segment.id,
        chapterId: segment.chapterId,
        type: segment.type,
        episodeStartSec: segment.episodeStartSec,
        episodeEndSec: segment.episodeEndSec,
        lucidity: segment.lucidity,
        polarity: segment.polarity,
        arousal: segment.arousal,
        subjectivity: segment.subjectivity,
        humor: segment.humor,
        transcriptExcerpt: segment.transcriptExcerpt,
      })),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to replace episode analysis: ${response.status} - ${errorText}`);
  }

  const { data } = await response.json();
  return data as ReplaceAnalysisResult;
}

/**
 * Update episode with graphiti episode IDs and final status
 */
export async function updateEpisodeComplete(
  episodeId: string,
  graphitiEpisodeIds: string[],
  duration?: number,
): Promise<void> {
  await fetch(`${getApiUrl()}/api/v1/episodes/${episodeId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      graphitiEpisodeIds,
      processingStatus: 'complete',
      ...(duration != null && { duration: Math.round(duration) }),
    }),
  });
}

/**
 * Update episode with error status
 */
export async function updateEpisodeError(
  episodeId: string,
  error: string
): Promise<void> {
  await fetch(`${getApiUrl()}/api/v1/episodes/${episodeId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      processingStatus: 'failed',
      processingError: error,
    }),
  });
}
