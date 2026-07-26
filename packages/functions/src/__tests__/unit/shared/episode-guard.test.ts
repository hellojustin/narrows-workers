import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
  isEpisodeIngestible,
  isSeriesIngestible,
} from "../../../shared/episode-guard";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NARROWS_API_URL = "https://narrows.test";
  process.env.NARROWS_API_KEY = "test-key";
});

describe("isEpisodeIngestible", () => {
  it("returns false when episode is missing", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(isEpisodeIngestible("ep-1")).resolves.toBe(false);
  });

  it("returns false when series is opted out", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "ep-1", seriesId: "series-1" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "series-1", opted_out: true } }),
      });

    await expect(isEpisodeIngestible("ep-1")).resolves.toBe(false);
  });

  it("returns true for a live episode on an active series", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "ep-1", series_id: "series-1" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "series-1", opted_out: false } }),
      });

    await expect(isEpisodeIngestible("ep-1")).resolves.toBe(true);
  });
});

describe("isSeriesIngestible", () => {
  it("returns false for opted-out series", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { id: "series-1", opted_out: true } }),
    });
    await expect(isSeriesIngestible("series-1")).resolves.toBe(false);
  });
});
