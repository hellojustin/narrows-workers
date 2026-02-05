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

/**
 * Upsert a chapter via Narrows API
 */
export async function upsertChapter(chapter: Chapter): Promise<void> {
  const response = await fetch(`${getApiUrl()}/api/v1/chapters/${chapter.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      episodeId: chapter.episodeId,
      type: chapter.type,
      title: chapter.title,
      summary: chapter.summary,
      episodeStartSec: chapter.episodeStartSec,
      episodeEndSec: chapter.episodeEndSec,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upsert chapter: ${response.status} - ${errorText}`);
  }
}

/**
 * Upsert a segment via Narrows API
 */
export async function upsertSegment(segment: Segment): Promise<void> {
  const response = await fetch(`${getApiUrl()}/api/v1/segments/${segment.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      episodeId: segment.episodeId,
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
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upsert segment: ${response.status} - ${errorText}`);
  }
}

/**
 * Update episode with graphiti episode IDs and final status
 */
export async function updateEpisodeComplete(
  episodeId: string,
  graphitiEpisodeIds: string[]
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
