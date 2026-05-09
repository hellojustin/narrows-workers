import type { ScheduledHandler } from "aws-lambda";

const NARROWS_API_URL = process.env.NARROWS_API_URL;
const NARROWS_API_KEY = process.env.NARROWS_API_KEY;

const LOOKBACK_HOURS = 2;
const PAGE_SIZE = 5000;

// Simple interval merge for the rollup
export function mergeIntervals(ranges: [number, number][]): [number, number][] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let curStart = sorted[0][0];
  let curEnd = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      out.push([curStart, curEnd]);
      curStart = s;
      curEnd = e;
    }
  }
  out.push([curStart, curEnd]);
  return out;
}

async function apiFetch(path: string, options: RequestInit = {}) {
  const response = await fetch(`${NARROWS_API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${NARROWS_API_KEY}`,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${path} returned ${response.status}: ${text}`);
  }
  return response.json();
}

interface RawEvent {
  id: string;
  user_id: string;
  episode_id: string;
  start_sec: number;
  end_sec: number;
  listened_at: string;
}

export const main: ScheduledHandler = async () => {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  console.log(`Rollup: fetching events since ${since}`);

  // Fetch all recent events (paginated)
  const allEvents: RawEvent[] = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await apiFetch(
      `/api/v1/internal/listening/events?since=${encodeURIComponent(since)}&page=${page}&per_page=${PAGE_SIZE}`,
    );
    allEvents.push(...result.data);
    hasMore = result.next_page !== null;
    page++;
  }

  console.log(`Rollup: fetched ${allEvents.length} events`);
  if (allEvents.length === 0) return;

  // Group by (user_id, episode_id)
  const groups = new Map<string, RawEvent[]>();
  for (const event of allEvents) {
    const key = `${event.user_id}:${event.episode_id}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }

  // Build summary upserts
  const summaries = [];
  for (const [key, events] of groups) {
    const [userId, episodeId] = key.split(":");
    const ranges: [number, number][] = events.map((e) => [e.start_sec, e.end_sec]);
    const merged = mergeIntervals(ranges);
    const totalListenSec = merged.reduce((sum, [s, e]) => sum + (e - s), 0);
    const listenedAts = events.map((e) => new Date(e.listened_at).getTime());

    summaries.push({
      user_id: userId,
      episode_id: episodeId,
      listened_ranges: merged,
      total_listen_sec: totalListenSec,
      listen_count: events.length,
      first_listened_at: new Date(Math.min(...listenedAts)).toISOString(),
      last_listened_at: new Date(Math.max(...listenedAts)).toISOString(),
    });
  }

  // Upsert summaries in batches of 100
  for (let i = 0; i < summaries.length; i += 100) {
    const batch = summaries.slice(i, i + 100);
    await apiFetch("/api/v1/internal/listening/summaries/upsert", {
      method: "POST",
      body: JSON.stringify({ summaries: batch }),
    });
  }
  console.log(`Rollup: upserted ${summaries.length} summaries`);

  // Build listening patterns
  // Group by (user_id, episode_id, day_of_week, hour_of_day, period)
  // Note: We don't have series_id here - we'd need episode->series mapping
  // For now, patterns are skipped in the rollup (they require joining episode->series data)
  // The narrows API could provide a dedicated endpoint for this in the future
  console.log("Rollup: patterns computation deferred (requires episode->series mapping)");
};
