import { describe, expect, it } from "vitest";

import {
  readRoutingConfig,
  routeTranscoder,
  seriesBucket,
  type RoutingConfig,
} from "../../../shared/transcoder-routing";

function config(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    defaultTranscoder: "mediaconvert",
    seriesIds: new Set(),
    percent: 0,
    ...overrides,
  };
}

describe("readRoutingConfig", () => {
  it("defaults to MediaConvert so an unconfigured stage keeps existing behaviour", () => {
    const result = readRoutingConfig({});
    expect(result.defaultTranscoder).toBe("mediaconvert");
    expect(result.percent).toBe(0);
    expect(result.seriesIds.size).toBe(0);
  });

  it("reads ffmpeg as the default only for an exact value", () => {
    expect(readRoutingConfig({ TRANSCODER: "ffmpeg" }).defaultTranscoder).toBe("ffmpeg");
    expect(readRoutingConfig({ TRANSCODER: " FFMPEG " }).defaultTranscoder).toBe("ffmpeg");
    // Anything unrecognised must fall back to the safe path rather than guessing.
    expect(readRoutingConfig({ TRANSCODER: "ffmpg" }).defaultTranscoder).toBe("mediaconvert");
    expect(readRoutingConfig({ TRANSCODER: "" }).defaultTranscoder).toBe("mediaconvert");
  });

  it("parses a series allow-list, ignoring whitespace and empty entries", () => {
    const result = readRoutingConfig({ FFMPEG_TRANSCODE_SERIES_IDS: " a , b ,, c " });
    expect([...result.seriesIds].sort()).toEqual(["a", "b", "c"]);
  });

  it("clamps the percentage and treats nonsense as zero", () => {
    expect(readRoutingConfig({ FFMPEG_TRANSCODE_PERCENT: "50" }).percent).toBe(50);
    expect(readRoutingConfig({ FFMPEG_TRANSCODE_PERCENT: "-5" }).percent).toBe(0);
    expect(readRoutingConfig({ FFMPEG_TRANSCODE_PERCENT: "1000" }).percent).toBe(100);
    expect(readRoutingConfig({ FFMPEG_TRANSCODE_PERCENT: "banana" }).percent).toBe(0);
  });
});

describe("seriesBucket", () => {
  it("is stable across calls, which is what makes raising the percentage additive", () => {
    const first = seriesBucket("series-abc");
    expect(seriesBucket("series-abc")).toBe(first);
    expect(seriesBucket("series-abc")).toBe(first);
  });

  it("stays within 0-99", () => {
    for (let i = 0; i < 500; i++) {
      const bucket = seriesBucket(`series-${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it("spreads series roughly evenly, so a percentage means what it says", () => {
    const buckets = Array.from({ length: 2000 }, (_, i) => seriesBucket(`series-${i}`));
    const belowTen = buckets.filter((b) => b < 10).length;
    // 10% of 2000 is 200. Allow generous slack; this catches a badly skewed hash,
    // not small sampling variation.
    expect(belowTen).toBeGreaterThan(120);
    expect(belowTen).toBeLessThan(300);
  });
});

describe("routeTranscoder", () => {
  it("sends everything to MediaConvert by default", () => {
    const decision = routeTranscoder({ seriesId: "series-1" }, config());
    expect(decision.transcoder).toBe("mediaconvert");
  });

  it("sends everything to ffmpeg once TRANSCODER is ffmpeg", () => {
    const decision = routeTranscoder(
      { seriesId: "series-1" },
      config({ defaultTranscoder: "ffmpeg" })
    );
    expect(decision.transcoder).toBe("ffmpeg");
  });

  it("routes an allow-listed series to ffmpeg", () => {
    const decision = routeTranscoder(
      { seriesId: "series-1" },
      config({ seriesIds: new Set(["series-1"]) })
    );
    expect(decision.transcoder).toBe("ffmpeg");
    expect(decision.reason).toMatch(/SERIES_IDS/);
  });

  it("leaves a series outside the allow-list on MediaConvert", () => {
    const decision = routeTranscoder(
      { seriesId: "series-2" },
      config({ seriesIds: new Set(["series-1"]) })
    );
    expect(decision.transcoder).toBe("mediaconvert");
  });

  it("routes by percentage using the series bucket", () => {
    // Find a series whose bucket is low, so the assertion does not depend on
    // the hash of a particular hardcoded string.
    const lowBucketSeries = Array.from({ length: 500 }, (_, i) => `series-${i}`).find(
      (id) => seriesBucket(id) < 10
    )!;

    expect(routeTranscoder({ seriesId: lowBucketSeries }, config({ percent: 10 })).transcoder).toBe(
      "ffmpeg"
    );
    expect(routeTranscoder({ seriesId: lowBucketSeries }, config({ percent: 0 })).transcoder).toBe(
      "mediaconvert"
    );
  });

  it("keeps a series on ffmpeg as the percentage rises", () => {
    // The property that matters for a staged rollout: widening never moves a
    // series back to MediaConvert.
    const ids = Array.from({ length: 200 }, (_, i) => `series-${i}`);
    for (const id of ids) {
      let wasFfmpeg = false;
      for (const percent of [10, 25, 50, 75, 100]) {
        const isFfmpeg = routeTranscoder({ seriesId: id }, config({ percent })).transcoder === "ffmpeg";
        if (wasFfmpeg) expect(isFfmpeg).toBe(true);
        wasFfmpeg = wasFfmpeg || isFfmpeg;
      }
    }
  });

  it("routes everything to ffmpeg at 100 percent", () => {
    for (let i = 0; i < 200; i++) {
      expect(routeTranscoder({ seriesId: `series-${i}` }, config({ percent: 100 })).transcoder).toBe(
        "ffmpeg"
      );
    }
  });

  it("falls back to MediaConvert when the episode has no series", () => {
    // Percentage routing needs a series to hash; without one the safe path wins
    // rather than routing at random.
    const decision = routeTranscoder({ seriesId: null }, config({ percent: 100 }));
    expect(decision.transcoder).toBe("mediaconvert");
  });
});
