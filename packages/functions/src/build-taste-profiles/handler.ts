import type { ScheduledHandler } from "aws-lambda";

const NARROWS_API_URL = process.env.NARROWS_API_URL;
const NARROWS_API_KEY = process.env.NARROWS_API_KEY;
const GRAPHITI_API_URL = process.env.GRAPHITI_API_URL;
const GRAPHITI_API_KEY = process.env.GRAPHITI_API_KEY;
const GRAPHITI_GRAPH_ID = process.env.GRAPHITI_GRAPH_ID;

const LOOKBACK_HOURS = 2;
const PAGE_SIZE = 1000;
const SEGMENT_BATCH_SIZE = 500;
const PROFILE_BATCH_SIZE = 50;
const RECENCY_HALF_LIFE_DAYS = 30;
const LN2 = Math.LN2;
const TOP_ENTITIES = 50;

// ---- API helpers ----

async function narrowsFetch(path: string, options: RequestInit = {}) {
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
    throw new Error(`Narrows ${path} returned ${response.status}: ${text}`);
  }
  return response.json();
}

async function graphitiFetch(path: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (GRAPHITI_API_KEY) headers["Authorization"] = `Bearer ${GRAPHITI_API_KEY}`;

  const response = await fetch(`${GRAPHITI_API_URL}${path}`, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graphiti ${path} returned ${response.status}: ${text}`);
  }
  return response.json();
}

// ---- Score math ----

function recencyDecay(dateStr: string | null): number {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 0;
  const daysAgo = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp((-LN2 / RECENCY_HALF_LIFE_DAYS) * Math.max(daysAgo, 0));
}

function listenWeight(pctComplete: number): number {
  return Math.min(1.0, pctComplete);
}

// ---- Types ----

interface SummaryRow {
  user_id: string;
  episode_id: string;
  series_id: string;
  total_listen_sec: number;
  pct_complete: number;
  last_listened_at: string | null;
}

interface SegmentMeta {
  id: string;
  episode_id: string;
  series_id: string | null;
  type: string;
  episode_start_sec: number;
  episode_end_sec: number;
  lucidity: number | null;
  polarity: number | null;
  arousal: number | null;
  subjectivity: number | null;
  humor: number | null;
  series_categories: string[] | null;
}

const SENTIMENT_KEYS = ["lucidity", "polarity", "arousal", "subjectivity", "humor"] as const;

// ---- Entity lookup via Graphiti ----

async function getEntityNamesForEpisodes(episodeIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!GRAPHITI_GRAPH_ID || !GRAPHITI_API_URL || episodeIds.length === 0) return result;

  // Get episodic nodes for these narrows episode_ids, then find entity connections
  // Use the graph's episodes endpoint filtered by episode_id
  for (const episodeId of episodeIds) {
    try {
      const data = await graphitiFetch(
        `/graphs/${GRAPHITI_GRAPH_ID}/episodes?episode_id=${encodeURIComponent(episodeId)}&page_size=100`,
      );
      const episodicUuids: string[] = (data.episodes ?? []).map((e: { uuid: string }) => e.uuid);

      // For each episodic node, get its 1-hop subgraph to find entity connections
      for (const uuid of episodicUuids.slice(0, 5)) {
        try {
          const sub = await graphitiFetch(
            `/graphs/${GRAPHITI_GRAPH_ID}/nodes/${uuid}?depth=1&max_nodes=50`,
          );
          const entityNames: string[] = [];
          for (const node of sub.nodes ?? []) {
            if (node.uuid === uuid) continue;
            const labels: string[] = node.labels ?? [];
            if (!labels.includes("Episodic") && !labels.includes("Topic") && !labels.includes("Community")) {
              entityNames.push(node.name);
            }
          }
          const existing = result.get(episodeId) ?? [];
          existing.push(...entityNames);
          result.set(episodeId, [...new Set(existing)]);
        } catch {
          // skip individual node failures
        }
      }
    } catch {
      // skip episode failures
    }
  }
  return result;
}

// ---- Profile builder ----

interface ProfileData {
  user_id: string;
  entity_affinities: Record<string, number>;
  sentiment_center: Record<string, number>;
  segment_type_dist: Record<string, number>;
  series_affinities: Record<string, number>;
  category_affinities: Record<string, number>;
}

async function buildProfileForUser(
  userId: string,
  summaries: SummaryRow[],
  allSegments: Map<string, SegmentMeta[]>,
  entityMap: Map<string, string[]>,
): Promise<ProfileData> {
  const seriesScores = new Map<string, number>();
  const categoryScores = new Map<string, number>();
  const entityScores = new Map<string, number>();
  const segTypeCounts = new Map<string, number>();
  const sentimentSums = new Map<string, number>();
  const sentimentWeights = new Map<string, number>();

  for (const s of summaries) {
    const weight = listenWeight(s.pct_complete) * recencyDecay(s.last_listened_at);
    if (weight <= 0) continue;

    // Series affinity
    if (s.series_id) {
      seriesScores.set(s.series_id, (seriesScores.get(s.series_id) ?? 0) + weight);
    }

    // Segment-level signals
    const segs = allSegments.get(s.episode_id) ?? [];
    const episodeDur = segs.reduce((max, seg) => Math.max(max, seg.episode_end_sec), 0);
    for (const seg of segs) {
      const segDur = seg.episode_end_sec - seg.episode_start_sec;
      const segWeight = episodeDur > 0 ? weight * (segDur / episodeDur) : weight / Math.max(segs.length, 1);

      // Segment type distribution
      segTypeCounts.set(seg.type, (segTypeCounts.get(seg.type) ?? 0) + segWeight);

      // Sentiment accumulation (dynamic keys)
      for (const key of SENTIMENT_KEYS) {
        const val = seg[key];
        if (val != null) {
          sentimentSums.set(key, (sentimentSums.get(key) ?? 0) + val * segWeight);
          sentimentWeights.set(key, (sentimentWeights.get(key) ?? 0) + segWeight);
        }
      }

      // Category affinities from series
      if (seg.series_categories) {
        for (const cat of seg.series_categories) {
          categoryScores.set(cat, (categoryScores.get(cat) ?? 0) + segWeight);
        }
      }
    }

    // Entity affinities
    const entities = entityMap.get(s.episode_id) ?? [];
    for (const name of entities) {
      entityScores.set(name, (entityScores.get(name) ?? 0) + weight);
    }
  }

  // Normalize segment type distribution
  const segTypeTotal = [...segTypeCounts.values()].reduce((a, b) => a + b, 0);
  const segmentTypeDist: Record<string, number> = {};
  if (segTypeTotal > 0) {
    for (const [k, v] of segTypeCounts) {
      segmentTypeDist[k] = Math.round((v / segTypeTotal) * 1000) / 1000;
    }
  }

  // Compute sentiment center (weighted average)
  const sentimentCenter: Record<string, number> = {};
  for (const key of sentimentSums.keys()) {
    const w = sentimentWeights.get(key) ?? 0;
    if (w > 0) {
      sentimentCenter[key] = Math.round(((sentimentSums.get(key) ?? 0) / w) * 100) / 100;
    }
  }

  // Truncate entity affinities to top N
  const sortedEntities = [...entityScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_ENTITIES);
  const entityAffinities: Record<string, number> = {};
  for (const [name, score] of sortedEntities) {
    entityAffinities[name] = Math.round(score * 1000) / 1000;
  }

  // Series + category: keep all, round scores
  const seriesAffinities: Record<string, number> = {};
  for (const [sid, score] of seriesScores) {
    seriesAffinities[sid] = Math.round(score * 1000) / 1000;
  }

  const categoryAffinities: Record<string, number> = {};
  for (const [cat, score] of categoryScores) {
    categoryAffinities[cat] = Math.round(score * 1000) / 1000;
  }

  return {
    user_id: userId,
    entity_affinities: entityAffinities,
    sentiment_center: sentimentCenter,
    segment_type_dist: segmentTypeDist,
    series_affinities: seriesAffinities,
    category_affinities: categoryAffinities,
  };
}

// ---- Main handler ----

export const main: ScheduledHandler = async () => {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  console.log(`TasteBuilder: fetching summaries updated since ${since}`);

  // 1. Fetch all recently-updated summaries (paginated)
  const allSummaries: SummaryRow[] = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await narrowsFetch(
      `/api/v1/internal/listening/summaries?since=${encodeURIComponent(since)}&page=${page}&per_page=${PAGE_SIZE}`,
    );
    allSummaries.push(...result.data);
    hasMore = result.next_page !== null;
    page++;
  }

  console.log(`TasteBuilder: fetched ${allSummaries.length} summaries`);
  if (allSummaries.length === 0) return;

  // Group summaries by user
  const byUser = new Map<string, SummaryRow[]>();
  for (const s of allSummaries) {
    const group = byUser.get(s.user_id) ?? [];
    group.push(s);
    byUser.set(s.user_id, group);
  }

  // Collect all unique episode_ids
  const allEpisodeIds = [...new Set(allSummaries.map((s) => s.episode_id))];

  // 2. Fetch segment metadata in batches
  const allSegments = new Map<string, SegmentMeta[]>();
  for (let i = 0; i < allEpisodeIds.length; i += SEGMENT_BATCH_SIZE) {
    const batch = allEpisodeIds.slice(i, i + SEGMENT_BATCH_SIZE);
    const result = await narrowsFetch(
      `/api/v1/internal/segments?episode_ids=${batch.join(",")}`,
    );
    for (const seg of result.segments ?? []) {
      const group = allSegments.get(seg.episode_id) ?? [];
      group.push(seg);
      allSegments.set(seg.episode_id, group);
    }
  }
  console.log(`TasteBuilder: fetched segments for ${allSegments.size} episodes`);

  // 3. Fetch entity associations from Graphiti
  const entityMap = await getEntityNamesForEpisodes(allEpisodeIds);
  console.log(`TasteBuilder: resolved entities for ${entityMap.size} episodes`);

  // 4. Build profiles per user
  const profiles: ProfileData[] = [];
  for (const [userId, summaries] of byUser) {
    const profile = await buildProfileForUser(userId, summaries, allSegments, entityMap);
    profiles.push(profile);
  }

  // 5. Upsert profiles in batches
  for (let i = 0; i < profiles.length; i += PROFILE_BATCH_SIZE) {
    const batch = profiles.slice(i, i + PROFILE_BATCH_SIZE);
    await narrowsFetch("/api/v1/internal/taste-profiles/upsert", {
      method: "POST",
      body: JSON.stringify({ profiles: batch }),
    });
  }
  console.log(`TasteBuilder: upserted ${profiles.length} taste profiles`);
};
