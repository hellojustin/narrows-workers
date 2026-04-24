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

// Minimum-data gate. Users below all three thresholds are skipped — their
// existing profile (default-seeded at user creation, or a previous Lambda
// build) is preserved. Computed against in-window summaries only.
const MIN_LISTEN_SEC = 300;
const MIN_ENTITIES = 10;
const MIN_SERIES = 3;

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

async function graphitiFetch(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (GRAPHITI_API_KEY) headers["Authorization"] = `Bearer ${GRAPHITI_API_KEY}`;

  const response = await fetch(`${GRAPHITI_API_URL}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string>) },
  });
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

function listenWeight(totalListenSec: number): number {
  if (totalListenSec <= 0) return 0;
  // Logarithmic scaling so early minutes count most but long listens still accumulate.
  // 10 min → ~0.51, 30 min → ~0.73, 60 min → ~0.86, 120 min → ~0.95
  return Math.min(1.0, Math.log2(1 + totalListenSec / 600));
}

// ---- Types ----

interface SummaryRow {
  user_id: string;
  episode_id: string;
  series_id: string;
  total_listen_sec: number;
  pct_complete: number;
  listened_ranges: [number, number][];
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

interface EpisodeRanges {
  episode_id: string;
  ranges: [number, number][];
}

/**
 * Collect listened_ranges per episode across all summaries, unioning ranges
 * for the same episode listened to by different users.
 */
function collectListenedRangesPerEpisode(summaries: SummaryRow[]): EpisodeRanges[] {
  const byEpisode = new Map<string, [number, number][]>();
  for (const s of summaries) {
    const ranges = s.listened_ranges ?? [];
    if (ranges.length === 0) continue;
    const existing = byEpisode.get(s.episode_id) ?? [];
    existing.push(...ranges);
    byEpisode.set(s.episode_id, existing);
  }

  const result: EpisodeRanges[] = [];
  for (const [episode_id, ranges] of byEpisode) {
    // Deduplicate overlapping ranges by merging
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [s, e] of sorted) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) {
        last[1] = Math.max(last[1], e);
      } else {
        merged.push([s, e]);
      }
    }
    result.push({ episode_id, ranges: merged });
  }
  return result;
}

const SUBGRAPH_BATCH_SIZE = 200;

/**
 * Resolve entity names for listened portions of episodes using two Graphiti calls:
 * 1. POST /episodes/filter — get episodic node UUIDs matching listened time ranges
 * 2. GET /nodes/subgraph — multi-root depth-1 traversal to find connected entities
 */
async function getEntityNamesForListenedPortions(
  episodeRanges: EpisodeRanges[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!GRAPHITI_GRAPH_ID || !GRAPHITI_API_URL || episodeRanges.length === 0) return result;

  // Step 1: Batch-filter episodic nodes by time overlap
  const filterPayload = {
    filters: episodeRanges.map((er) => ({
      episode_id: er.episode_id,
      ranges: er.ranges,
    })),
  };

  const filterResult = await graphitiFetch(
    `/graphs/${GRAPHITI_GRAPH_ID}/episodes/filter`,
    { method: "POST", body: JSON.stringify(filterPayload) },
  );

  // Build a map from episodic UUID -> narrows episode_id, and collect all UUIDs
  const uuidToEpisodeId = new Map<string, string>();
  const allEpisodicUuids: string[] = [];

  for (const item of filterResult.results ?? []) {
    const episodeId: string = item.episode_id;
    for (const ep of item.episodes ?? []) {
      uuidToEpisodeId.set(ep.uuid, episodeId);
      allEpisodicUuids.push(ep.uuid);
    }
  }

  console.log(`TasteBuilder: episode filter returned ${allEpisodicUuids.length} episodic nodes from ${episodeRanges.length} episodes (${filterResult.results?.length ?? 0} result groups)`);
  if (allEpisodicUuids.length === 0) return result;

  // Step 2: Multi-root subgraph traversal in batches
  const totalBatches = Math.ceil(allEpisodicUuids.length / SUBGRAPH_BATCH_SIZE);
  for (let i = 0; i < allEpisodicUuids.length; i += SUBGRAPH_BATCH_SIZE) {
    const batchIdx = Math.floor(i / SUBGRAPH_BATCH_SIZE) + 1;
    const batch = allEpisodicUuids.slice(i, i + SUBGRAPH_BATCH_SIZE);
    const params = new URLSearchParams();
    for (const uuid of batch) {
      params.append("node_uuids", uuid);
    }
    params.set("depth", "1");
    params.set("max_nodes", "5000");

    const sub = await graphitiFetch(
      `/graphs/${GRAPHITI_GRAPH_ID}/nodes/subgraph?${params.toString()}`,
    );

    console.log(`TasteBuilder: subgraph batch ${batchIdx}/${totalBatches}: ${(sub.nodes ?? []).length} nodes, ${(sub.edges ?? []).length} edges`);

    // Extract entity names connected to each episodic root
    const rootUuids = new Set(batch);
    for (const edge of sub.edges ?? []) {
      const sourceUuid: string = edge.source_node_uuid;
      const targetUuid: string = edge.target_node_uuid;

      // Find which side is the episodic root and which is the entity
      let episodicUuid: string | undefined;
      let entityUuid: string | undefined;
      if (rootUuids.has(sourceUuid)) {
        episodicUuid = sourceUuid;
        entityUuid = targetUuid;
      } else if (rootUuids.has(targetUuid)) {
        episodicUuid = targetUuid;
        entityUuid = sourceUuid;
      }
      if (!episodicUuid || !entityUuid) continue;

      // Find the entity node to get its name and labels
      const entityNode = (sub.nodes ?? []).find((n: { uuid: string }) => n.uuid === entityUuid);
      if (!entityNode) continue;

      const labels: string[] = entityNode.labels ?? [];
      if (labels.includes("Episodic") || labels.includes("Topic") || labels.includes("Community")) continue;

      const episodeId = uuidToEpisodeId.get(episodicUuid);
      if (!episodeId) continue;

      const existing = result.get(episodeId) ?? [];
      if (!existing.includes(entityNode.name)) {
        existing.push(entityNode.name);
      }
      result.set(episodeId, existing);
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
    const weight = listenWeight(s.total_listen_sec) * recencyDecay(s.last_listened_at);
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
  const t0 = Date.now();
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  console.log("TasteBuilder: starting", {
    since,
    lookbackHours: LOOKBACK_HOURS,
    narrowsApi: NARROWS_API_URL ?? "(unset)",
    graphitiApi: GRAPHITI_API_URL ?? "(unset)",
    graphitiGraphId: GRAPHITI_GRAPH_ID ?? "(unset)",
  });

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

  if (allSummaries.length === 0) {
    console.log(`TasteBuilder: no summaries updated since ${since}, nothing to do (${Date.now() - t0}ms)`);
    return;
  }

  // Group summaries by user
  const byUser = new Map<string, SummaryRow[]>();
  for (const s of allSummaries) {
    const group = byUser.get(s.user_id) ?? [];
    group.push(s);
    byUser.set(s.user_id, group);
  }

  // Collect all unique episode_ids
  const allEpisodeIds = [...new Set(allSummaries.map((s) => s.episode_id))];

  const withRanges = allSummaries.filter((s) => (s.listened_ranges ?? []).length > 0).length;
  console.log(`TasteBuilder: fetched ${allSummaries.length} summaries across ${byUser.size} users, ${allEpisodeIds.length} unique episodes (${withRanges} have listened_ranges) (${Date.now() - t0}ms)`);

  // 2. Fetch segment metadata in batches
  const t1 = Date.now();
  const allSegments = new Map<string, SegmentMeta[]>();
  let totalSegments = 0;
  for (let i = 0; i < allEpisodeIds.length; i += SEGMENT_BATCH_SIZE) {
    const batch = allEpisodeIds.slice(i, i + SEGMENT_BATCH_SIZE);
    const result = await narrowsFetch(
      `/api/v1/internal/segments?episode_ids=${batch.join(",")}`,
    );
    for (const seg of result.segments ?? []) {
      const group = allSegments.get(seg.episode_id) ?? [];
      group.push(seg);
      allSegments.set(seg.episode_id, group);
      totalSegments++;
    }
  }
  console.log(`TasteBuilder: fetched ${totalSegments} segments across ${allSegments.size}/${allEpisodeIds.length} episodes (${Date.now() - t1}ms)`);

  // 3. Fetch entity associations from Graphiti (filtered to listened portions)
  const t2 = Date.now();
  const episodeRanges = collectListenedRangesPerEpisode(allSummaries);

  if (episodeRanges.length === 0) {
    console.log("TasteBuilder: no episodes have listened_ranges, skipping entity lookup");
  } else if (!GRAPHITI_GRAPH_ID || !GRAPHITI_API_URL) {
    console.log("TasteBuilder: GRAPHITI_GRAPH_ID or GRAPHITI_API_URL not set, skipping entity lookup");
  } else {
    console.log(`TasteBuilder: resolving entities for ${episodeRanges.length} episodes with listened_ranges`);
  }

  const entityMap = await getEntityNamesForListenedPortions(episodeRanges);
  const totalEntities = [...entityMap.values()].reduce((sum, names) => sum + names.length, 0);
  console.log(`TasteBuilder: resolved ${totalEntities} unique entities across ${entityMap.size} episodes (${Date.now() - t2}ms)`);

  // 4. Build profiles per user
  const t3 = Date.now();
  const profiles: ProfileData[] = [];
  let skippedBelowThreshold = 0;
  for (const [userId, summaries] of byUser) {
    const profile = await buildProfileForUser(userId, summaries, allSegments, entityMap);
    const totalSec = summaries.reduce((sum, s) => sum + s.total_listen_sec, 0);
    const distinctSeries = new Set(summaries.map((s) => s.series_id).filter(Boolean)).size;
    const distinctEntities = Object.keys(profile.entity_affinities).length;

    if (totalSec < MIN_LISTEN_SEC || distinctEntities < MIN_ENTITIES || distinctSeries < MIN_SERIES) {
      skippedBelowThreshold++;
      console.log(`TasteBuilder: skip ${userId.slice(0, 8)} below threshold`, {
        sec: Math.round(totalSec),
        entities: distinctEntities,
        series: distinctSeries,
      });
      continue;
    }
    profiles.push(profile);
  }
  if (skippedBelowThreshold > 0) {
    console.log(`TasteBuilder: skipped ${skippedBelowThreshold}/${byUser.size} users below threshold (existing profiles preserved)`);
  }

  const profileStats = profiles.map((p) => ({
    user: p.user_id.slice(0, 8),
    entities: Object.keys(p.entity_affinities).length,
    series: Object.keys(p.series_affinities).length,
    categories: Object.keys(p.category_affinities).length,
    sentimentKeys: Object.keys(p.sentiment_center).length,
    segTypes: Object.keys(p.segment_type_dist).length,
  }));
  console.log(`TasteBuilder: built ${profiles.length} profiles (${Date.now() - t3}ms)`, JSON.stringify(profileStats));

  // 5. Upsert profiles in batches
  const t4 = Date.now();
  for (let i = 0; i < profiles.length; i += PROFILE_BATCH_SIZE) {
    const batch = profiles.slice(i, i + PROFILE_BATCH_SIZE);
    await narrowsFetch("/api/v1/internal/taste-profiles/upsert", {
      method: "POST",
      body: JSON.stringify({ profiles: batch }),
    });
  }
  console.log(`TasteBuilder: upserted ${profiles.length} profiles (${Date.now() - t4}ms)`);
  console.log(`TasteBuilder: done in ${Date.now() - t0}ms`);
};
