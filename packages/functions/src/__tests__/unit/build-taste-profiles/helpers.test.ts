import { describe, it, expect } from "vitest";
import {
  recencyDecay,
  listenWeight,
  collectListenedRangesPerEpisode,
} from "@/build-taste-profiles/handler";

describe("recencyDecay", () => {
  it("returns 0 for null", () => {
    expect(recencyDecay(null)).toBe(0);
  });

  it("returns 0 for invalid date string", () => {
    expect(recencyDecay("not-a-date")).toBe(0);
  });

  it("returns 1.0 for now (no decay)", () => {
    const now = new Date().toISOString();
    const result = recencyDecay(now);
    expect(result).toBeCloseTo(1.0, 2);
  });

  it("returns ~0.5 for content listened 30 days ago (half-life)", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = recencyDecay(thirtyDaysAgo);
    expect(result).toBeCloseTo(0.5, 1);
  });

  it("returns value between 0 and 1 for any past date", () => {
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const result = recencyDecay(oneYearAgo);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  it("is monotonically decreasing — older = lower score", () => {
    const recent = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const older = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    expect(recencyDecay(recent)).toBeGreaterThan(recencyDecay(older));
  });
});

describe("listenWeight", () => {
  it("returns 0 for 0 seconds", () => {
    expect(listenWeight(0)).toBe(0);
  });

  it("returns 0 for negative seconds", () => {
    expect(listenWeight(-10)).toBe(0);
  });

  it("returns a value between 0 and 1", () => {
    expect(listenWeight(60)).toBeGreaterThan(0);
    expect(listenWeight(60)).toBeLessThanOrEqual(1);
    expect(listenWeight(3600)).toBeLessThanOrEqual(1);
  });

  it("is monotonically increasing below the cap", () => {
    // Cap is hit at 600s (10 min): log2(1 + 600/600) = log2(2) = 1.0
    expect(listenWeight(300)).toBeGreaterThan(listenWeight(60));
    expect(listenWeight(500)).toBeGreaterThan(listenWeight(300));
  });

  it("caps at 1.0 at 10 minutes and beyond", () => {
    expect(listenWeight(600)).toBe(1.0);
    expect(listenWeight(3600)).toBe(1.0);
    expect(listenWeight(999999)).toBe(1.0);
  });

  it("approximates expected values for short listen times", () => {
    // 1 min (60s): log2(1 + 60/600) = log2(1.1) ≈ 0.137
    expect(listenWeight(60)).toBeCloseTo(0.137, 2);
    // 5 min (300s): log2(1 + 300/600) = log2(1.5) ≈ 0.585
    expect(listenWeight(300)).toBeCloseTo(0.585, 2);
  });
});

describe("collectListenedRangesPerEpisode", () => {
  it("returns empty result for empty input", () => {
    expect(collectListenedRangesPerEpisode([])).toEqual([]);
  });

  it("ignores summaries with no listened_ranges", () => {
    const summaries = [
      {
        user_id: "u1",
        episode_id: "ep1",
        series_id: "s1",
        total_listen_sec: 100,
        pct_complete: 0.5,
        listened_ranges: [],
        last_listened_at: null,
      },
    ];
    expect(collectListenedRangesPerEpisode(summaries)).toEqual([]);
  });

  it("returns ranges for a single episode with a single user", () => {
    const summaries = [
      {
        user_id: "u1",
        episode_id: "ep1",
        series_id: "s1",
        total_listen_sec: 60,
        pct_complete: 0.5,
        listened_ranges: [[0, 60]] as [number, number][],
        last_listened_at: null,
      },
    ];
    const result = collectListenedRangesPerEpisode(summaries);
    expect(result).toHaveLength(1);
    expect(result[0].episode_id).toBe("ep1");
    expect(result[0].ranges).toEqual([[0, 60]]);
  });

  it("unions ranges from multiple users for the same episode", () => {
    const summaries = [
      {
        user_id: "u1",
        episode_id: "ep1",
        series_id: "s1",
        total_listen_sec: 60,
        pct_complete: 0.5,
        listened_ranges: [[0, 60]] as [number, number][],
        last_listened_at: null,
      },
      {
        user_id: "u2",
        episode_id: "ep1",
        series_id: "s1",
        total_listen_sec: 60,
        pct_complete: 0.5,
        listened_ranges: [[30, 90]] as [number, number][],
        last_listened_at: null,
      },
    ];
    const result = collectListenedRangesPerEpisode(summaries);
    expect(result).toHaveLength(1);
    // Ranges should be merged: [0,60] + [30,90] = [0,90]
    expect(result[0].ranges).toEqual([[0, 90]]);
  });

  it("keeps separate episodes separate", () => {
    const summaries = [
      {
        user_id: "u1",
        episode_id: "ep1",
        series_id: "s1",
        total_listen_sec: 60,
        pct_complete: 0.5,
        listened_ranges: [[0, 60]] as [number, number][],
        last_listened_at: null,
      },
      {
        user_id: "u1",
        episode_id: "ep2",
        series_id: "s1",
        total_listen_sec: 30,
        pct_complete: 0.3,
        listened_ranges: [[100, 130]] as [number, number][],
        last_listened_at: null,
      },
    ];
    const result = collectListenedRangesPerEpisode(summaries);
    expect(result).toHaveLength(2);
    const ep1 = result.find((r) => r.episode_id === "ep1");
    const ep2 = result.find((r) => r.episode_id === "ep2");
    expect(ep1?.ranges).toEqual([[0, 60]]);
    expect(ep2?.ranges).toEqual([[100, 130]]);
  });
});
