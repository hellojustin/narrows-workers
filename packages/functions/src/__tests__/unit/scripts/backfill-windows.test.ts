import { describe, expect, it, vi } from "vitest";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import {
  estimate,
  parseArgs,
  parseRows,
  processEpisode,
  selectionSql,
  toCandidates,
} from "../../../../../../scripts/backfill-windows";

const SERIES_ID = "3eb0f0ec-8203-4575-9d5b-87288ec831b5";

describe("parseArgs", () => {
  it("defaults to four episodes in parallel and no filters", () => {
    expect(parseArgs([])).toEqual({ dryRun: false, force: false, concurrency: 4 });
  });

  it("reads every flag", () => {
    expect(
      parseArgs([
        "--dry-run",
        "--force",
        "--limit",
        "20",
        "--concurrency",
        "8",
        "--series",
        SERIES_ID,
        "--since",
        "2026-09-15",
      ])
    ).toEqual({
      dryRun: true,
      force: true,
      limit: 20,
      concurrency: 8,
      seriesId: SERIES_ID,
      since: "2026-09-15",
    });
  });

  it.each([
    [["--limit", "0"], /positive integer/],
    [["--concurrency", "x"], /positive integer/],
    [["--series", "not-a-uuid"], /series UUID/],
    [["--since", "15/09/2026"], /YYYY-MM-DD/],
    [["--since", "'; DROP TABLE episodes; --"], /YYYY-MM-DD/],
    [["--queue-url", "x"], /Unknown argument/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv as string[])).toThrow(message);
  });
});

describe("selectionSql", () => {
  it("selects live episodes with audio, newest first", () => {
    const sql = selectionSql({});
    expect(sql).toContain("deleted_at IS NULL");
    expect(sql).toContain("audio_media_id IS NOT NULL");
    expect(sql).toContain("ORDER BY published_at DESC NULLS LAST");
    expect(sql).not.toContain("LIMIT");
  });

  it("applies series, since and limit", () => {
    const sql = selectionSql({ seriesId: SERIES_ID, since: "2026-09-15", limit: 20 });
    expect(sql).toContain(`series_id = '${SERIES_ID}'`);
    expect(sql).toContain("published_at >= '2026-09-15'");
    expect(sql).toContain("LIMIT 20");
  });
});

describe("parseRows / toCandidates", () => {
  it("reads tab-separated psql output", () => {
    const rows = parseRows("ep1\tmedia1\t3600\nep2\tmedia2\t0\n");
    expect(toCandidates(rows)).toEqual([
      { episodeId: "ep1", audioMediaId: "media1", durationSec: 3600 },
      { episodeId: "ep2", audioMediaId: "media2", durationSec: 0 },
    ]);
  });
});

describe("estimate", () => {
  it("uses the measured tokens per hour and list price", () => {
    const e = estimate(7226 * 3600);
    expect(e.audioHours).toBeCloseTo(7226);
    expect(e.tokens / 1e9).toBeCloseTo(1.04, 2);
    expect(e.usd).toBeCloseTo(20.75, 1);
  });
});

describe("processEpisode", () => {
  const candidate = { episodeId: "ep1", audioMediaId: "media1", durationSec: 60 };
  const transcript = {
    results: {
      audio_segments: [
        { id: "0", start_time: "0.0", end_time: "4.0", transcript: "hello there", speaker_label: "spk_0" },
        { id: "1", start_time: "4.0", end_time: "9.0", transcript: "general kenobi", speaker_label: "spk_1" },
      ],
      items: [],
    },
  };

  function fakeS3(opts: { transcript?: unknown; putError?: Error }) {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        if (opts.transcript === undefined) {
          throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        }
        return { Body: { transformToString: async () => JSON.stringify(opts.transcript) } };
      }
      if (command instanceof HeadObjectCommand) {
        throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      }
      if (command instanceof PutObjectCommand && opts.putError) throw opts.putError;
      return {};
    });
    return { client: { send } as never, send };
  }

  const openai = {
    embeddings: {
      create: vi.fn(async (body: { input: string[] }) => ({
        data: body.input.map((_, index) => ({ index, embedding: new Array(1024).fill(0.01) })),
        usage: { total_tokens: 7 * body.input.length },
      })),
    },
  } as never;

  it("writes windows.bin and reports tokens", async () => {
    const s3 = fakeS3({ transcript });
    const result = await processEpisode(candidate, { s3: s3.client, openai, bucket: "b", force: false });
    expect(result).toMatchObject({ episodeId: "ep1", status: "written", sentenceCount: 2, tokens: 28 });
    const put = s3.send.mock.calls.map((c) => c[0]).find((c) => c instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input.Key).toBe("processed/media1/windows.bin");
  });

  it("reports a missing transcript without throwing", async () => {
    const s3 = fakeS3({});
    const result = await processEpisode(candidate, { s3: s3.client, openai, bucket: "b", force: false });
    expect(result).toEqual({ episodeId: "ep1", audioMediaId: "media1", status: "no-transcript" });
  });

  it("returns a failure instead of throwing", async () => {
    const s3 = fakeS3({ transcript, putError: new Error("SlowDown") });
    const result = await processEpisode(candidate, { s3: s3.client, openai, bucket: "b", force: false });
    expect(result).toMatchObject({ status: "failed", error: "SlowDown" });
  });
});

describe("script safety", () => {
  it("never imports an SQS client", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../../../../../scripts/backfill-windows.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/client-sqs|SQSClient|SendMessage/);
  });
});
