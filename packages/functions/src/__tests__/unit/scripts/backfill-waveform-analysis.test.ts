import { describe, expect, it } from "vitest";

import {
  analysisMessageBody,
  assertAnalysisQueue,
  chunk,
  estimateCost,
  isMissingObjectError,
  parseArgs,
  parseRows,
  selectionSql,
  statusCountSql,
  toCandidates,
} from "../../../../../../scripts/backfill-waveform-analysis";

const ANALYSIS_QUEUE = "https://sqs.us-east-1.amazonaws.com/897768183373/narrows-production-audio-analysis";
const TRANSCODE_QUEUE = "https://sqs.us-east-1.amazonaws.com/897768183373/narrows-production-audio-transcode";
const SERIES_ID = "3eb0f0ec-8203-4575-9d5b-87288ec831b5";

describe("parseArgs", () => {
  it("defaults to enqueueing in batches of 10 up to a depth of 50", () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      queueDepthCeiling: 50,
      batchSize: 10,
      concurrency: 20,
    });
  });

  it("reads every flag", () => {
    const options = parseArgs([
      "--dry-run",
      "--limit",
      "20",
      "--queue-depth-ceiling",
      "10",
      "--batch-size",
      "5",
      "--concurrency",
      "4",
      "--series",
      SERIES_ID,
    ]);

    expect(options).toEqual({
      dryRun: true,
      limit: 20,
      queueDepthCeiling: 10,
      batchSize: 5,
      concurrency: 4,
      seriesId: SERIES_ID,
    });
  });

  it.each([["--limit", "0"], ["--batch-size", "-1"], ["--queue-depth-ceiling", "abc"], ["--limit", undefined]])(
    "rejects %s %s",
    (flag, value) => {
      const argv = value === undefined ? [flag] : [flag, value];
      expect(() => parseArgs(argv)).toThrow(/positive integer/);
    }
  );

  it("rejects a series that is not a UUID", () => {
    expect(() => parseArgs(["--series", "the-daily"])).toThrow(/series UUID/);
  });

  it("rejects unknown arguments rather than ignoring them", () => {
    expect(() => parseArgs(["--transcode"])).toThrow(/Unknown argument/);
  });
});

describe("assertAnalysisQueue", () => {
  it("accepts an audio-analysis queue", () => {
    expect(() => assertAnalysisQueue(ANALYSIS_QUEUE)).not.toThrow();
  });

  // The safety property this script exists under: a transcode message fans in to
  // subtitle generation and transcript re-ingest, which duplicates segments and
  // chapters (PROD-218).
  it("refuses the transcode queue", () => {
    expect(() => assertAnalysisQueue(TRANSCODE_QUEUE)).toThrow(/-audio-analysis/);
  });

  it("refuses any other queue", () => {
    expect(() =>
      assertAnalysisQueue("https://sqs.us-east-1.amazonaws.com/897768183373/narrows-production-processing")
    ).toThrow(/only ever enqueues waveform analysis/);
  });
});

describe("analysisMessageBody", () => {
  it("sends episodeId and audioMediaId, and leaves writeJson to the handler", () => {
    const body = analysisMessageBody({
      episodeId: "episode-1",
      audioMediaId: "media-1",
      durationSec: 1_200,
    });

    expect(JSON.parse(body)).toEqual({ episodeId: "episode-1", audioMediaId: "media-1" });
    expect(body).not.toContain("writeJson");
  });
});

describe("selectionSql", () => {
  it("selects only pending episodes with audio", () => {
    const sql = selectionSql({});
    expect(sql).toContain("waveform_status IS NULL");
    expect(sql).toContain("audio_media_id IS NOT NULL");
    expect(sql).toContain("deleted_at IS NULL");
    expect(sql).not.toContain("LIMIT");
    expect(sql).not.toContain("series_id = '");
  });

  it("orders largest series first", () => {
    expect(selectionSql({})).toContain("ORDER BY s.pending DESC");
  });

  it("applies a limit and a series filter", () => {
    const sql = selectionSql({ limit: 20, seriesId: SERIES_ID });
    expect(sql).toContain("LIMIT 20");
    expect(sql).toContain(`e.series_id = '${SERIES_ID}'`);
  });
});

describe("statusCountSql", () => {
  it("counts ready and failed over the same population as the selection", () => {
    const sql = statusCountSql();
    expect(sql).toContain("waveform_status = 'ready'");
    expect(sql).toContain("waveform_status = 'failed'");
    expect(sql).toContain("audio_media_id IS NOT NULL");
  });

  it("scopes to a series when given one", () => {
    expect(statusCountSql(SERIES_ID)).toContain(`series_id = '${SERIES_ID}'`);
  });
});

describe("parseRows", () => {
  it("splits tab-separated psql output and drops the trailing newline", () => {
    expect(parseRows("a\t1\nb\t2\n")).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("returns nothing for an empty result", () => {
    expect(parseRows("")).toEqual([]);
  });
});

describe("toCandidates", () => {
  it("reads duration as a number", () => {
    expect(toCandidates([["episode-1", "media-1", "3600"]])).toEqual([
      { episodeId: "episode-1", audioMediaId: "media-1", durationSec: 3_600 },
    ]);
  });

  it("treats a zeroed duration as zero rather than NaN", () => {
    expect(toCandidates([["episode-1", "media-1", "0"]])[0].durationSec).toBe(0);
  });
});

describe("isMissingObjectError", () => {
  it("treats NotFound and 404 as a missing raw object", () => {
    expect(isMissingObjectError({ name: "NotFound" })).toBe(true);
    expect(isMissingObjectError({ $metadata: { httpStatusCode: 404 } })).toBe(true);
  });

  it("does not treat access or throttling errors as a missing object", () => {
    expect(isMissingObjectError({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } })).toBe(
      false
    );
    expect(isMissingObjectError({ name: "SlowDown", $metadata: { httpStatusCode: 503 } })).toBe(
      false
    );
    expect(isMissingObjectError(undefined)).toBe(false);
  });
});

describe("chunk", () => {
  it("splits into batches no larger than the size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns nothing for an empty list", () => {
    expect(chunk([], 10)).toEqual([]);
  });
});

describe("estimateCost", () => {
  // One hour of audio at 36x realtime is 100 s of Lambda time, which at 1769 MB
  // is 172.75 GB-s, which at $0.0000133334 per GB-s is $0.002303.
  it("prices one hour of audio", () => {
    const estimate = estimateCost(1, 3_600);

    expect(estimate.audioHours).toBe(1);
    expect(estimate.computeHours).toBeCloseTo(0.02778, 5);
    expect(estimate.gbSeconds).toBeCloseTo(172.75, 1);
    expect(estimate.computeUsd).toBeCloseTo(0.002303, 6);
    expect(estimate.requestUsd).toBeCloseTo(0.0000002, 9);
  });

  it("prices the full catalogue", () => {
    const estimate = estimateCost(17_141, 6_352.3 * 3_600);

    expect(estimate.computeHours).toBeCloseTo(176.5, 1);
    expect(estimate.totalUsd).toBeCloseTo(14.64, 1);
  });

  it("divides wall time by the reserved concurrency of 3", () => {
    const estimate = estimateCost(1, 3_600);
    expect(estimate.wallHours).toBeCloseTo(estimate.computeHours / 3, 6);
  });

  it("costs nothing when there is nothing to do", () => {
    expect(estimateCost(0, 0).totalUsd).toBe(0);
  });
});
