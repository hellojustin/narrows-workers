/**
 * Shared guards for skipping work when an episode/series is no longer
 * ingestible (soft-deleted after opt-out, or series.opted_out).
 */

export async function fetchEpisodeOrNull(
  episodeId: string
): Promise<Record<string, unknown> | null> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;
  if (!apiUrl || !apiKey) return null;

  const response = await fetch(`${apiUrl}/api/v1/episodes/${episodeId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return null;
  const { data } = (await response.json()) as { data: Record<string, unknown> };
  return data ?? null;
}

export async function fetchSeriesOrNull(
  seriesId: string
): Promise<Record<string, unknown> | null> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;
  if (!apiUrl || !apiKey) return null;

  const response = await fetch(`${apiUrl}/api/v1/series/${seriesId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return null;
  const { data } = (await response.json()) as { data: Record<string, unknown> };
  return data ?? null;
}

/**
 * Returns true if the episode exists and its series is not opted out.
 * Soft-deleted episodes 404 and are treated as not alive.
 */
export async function isEpisodeIngestible(episodeId: string): Promise<boolean> {
  const episode = await fetchEpisodeOrNull(episodeId);
  if (!episode) return false;

  const seriesId = (episode.series_id ?? episode.seriesId) as string | undefined;
  if (!seriesId) return true;

  const series = await fetchSeriesOrNull(seriesId);
  if (!series) return false;
  if (series.opted_out === true) return false;
  return true;
}

/**
 * Returns true if the series exists and is not opted out.
 */
export async function isSeriesIngestible(seriesId: string): Promise<boolean> {
  const series = await fetchSeriesOrNull(seriesId);
  if (!series) return false;
  if (series.opted_out === true) return false;
  return true;
}
