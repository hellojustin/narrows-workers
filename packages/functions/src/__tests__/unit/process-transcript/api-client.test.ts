import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { replaceEpisodeAnalysis } from "../../../process-transcript/api-client";
import type { Chapter, Segment } from "../../../process-transcript/types";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NARROWS_API_URL = "https://narrows.test";
  process.env.NARROWS_API_KEY = "test-key";
});

const chapter: Chapter = {
  id: "chapter-1",
  episodeId: "ep-1",
  type: "introduction",
  title: "Opening",
  summary: "The hosts introduce the episode.",
  episodeStartSec: 0,
  episodeEndSec: 60,
};

// Scores are 0 to 5, except polarity which is -5 to +5.
const segment: Segment = {
  id: "segment-1",
  episodeId: "ep-1",
  chapterId: "chapter-1",
  type: "episode-intro",
  episodeStartSec: 0,
  episodeEndSec: 30,
  lucidity: 4,
  polarity: 1,
  arousal: 2,
  subjectivity: 3,
  humor: 1,
  transcriptExcerpt: { content: "Welcome back." },
};

function okResponse(counts: Partial<Record<string, number>> = {}) {
  return {
    ok: true,
    json: async () => ({
      data: {
        chaptersCreated: 1,
        segmentsCreated: 1,
        chaptersRemoved: 0,
        segmentsRemoved: 0,
        ...counts,
      },
    }),
  };
}

describe("replaceEpisodeAnalysis", () => {
  it("sends chapters and segments together in a single request", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());

    await replaceEpisodeAnalysis("ep-1", [chapter], [segment]);

    // One request is the point of this function: splitting the write reopens
    // the window that lets two ingestion passes both append their results.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://narrows.test/api/v1/episodes/ep-1/analysis");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer test-key");

    const body = JSON.parse(init.body);
    expect(body.chapters).toHaveLength(1);
    expect(body.segments).toHaveLength(1);
  });

  it("preserves the caller's chapter and segment ids", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());

    await replaceEpisodeAnalysis("ep-1", [chapter], [segment]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.chapters[0].id).toBe("chapter-1");
    expect(body.segments[0].id).toBe("segment-1");
    expect(body.segments[0].chapterId).toBe("chapter-1");
  });

  it("does not send episodeId on the rows, since the route takes it from the path", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());

    await replaceEpisodeAnalysis("ep-1", [chapter], [segment]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.chapters[0]).not.toHaveProperty("episodeId");
    expect(body.segments[0]).not.toHaveProperty("episodeId");
  });

  it("returns the counts the route reports", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ chaptersCreated: 10, segmentsCreated: 12, chaptersRemoved: 10, segmentsRemoved: 12 })
    );

    await expect(replaceEpisodeAnalysis("ep-1", [chapter], [segment])).resolves.toEqual({
      chaptersCreated: 10,
      segmentsCreated: 12,
      chaptersRemoved: 10,
      segmentsRemoved: 12,
    });
  });

  it("sends empty arrays rather than skipping the call, so an episode with no analysis is cleared", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ chaptersCreated: 0, segmentsCreated: 0, chaptersRemoved: 5, segmentsRemoved: 6 })
    );

    const result = await replaceEpisodeAnalysis("ep-1", [], []);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.chapters).toEqual([]);
    expect(body.segments).toEqual([]);
    expect(result.chaptersRemoved).toBe(5);
  });

  it("throws with the response body when the route rejects the write", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "segment references unknown chapterId",
    });

    await expect(replaceEpisodeAnalysis("ep-1", [chapter], [segment])).rejects.toThrow(
      "Failed to replace episode analysis: 400 - segment references unknown chapterId"
    );
  });
});
