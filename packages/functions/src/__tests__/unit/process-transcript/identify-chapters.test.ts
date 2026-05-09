import { describe, it, expect } from "vitest";
import {
  buildTranscriptSummary,
  createDefaultChapters,
  validateAndFixChapters,
} from "@/process-transcript/identify-chapters";
import type { TranscriptSegment, SpeakerData, Chapter } from "@/process-transcript/types";

const EPISODE_ID = "ep-001";

const speakerData: SpeakerData = {
  spk_0: { name: "Alice", role: "host" },
  spk_1: { name: "Bob", role: "guest" },
};

const segments: TranscriptSegment[] = [
  { id: "s1", start_time: "0.0", end_time: "15.0", transcript: "Hello everyone.", speaker_label: "spk_0" },
  { id: "s2", start_time: "15.0", end_time: "45.0", transcript: "Welcome to the show.", speaker_label: "spk_0" },
  { id: "s3", start_time: "45.0", end_time: "90.0", transcript: "Thanks for having me.", speaker_label: "spk_1" },
  { id: "s4", start_time: "90.0", end_time: "120.0", transcript: "Let's dive in.", speaker_label: "spk_0" },
];

describe("buildTranscriptSummary", () => {
  it("groups segments into 30-second blocks", () => {
    const summary = buildTranscriptSummary(segments, speakerData);
    expect(summary).toContain("[Alice]");
    expect(summary).toContain("[Bob]");
    expect(summary).toContain("0:00");
  });

  it("returns empty string for no segments", () => {
    const summary = buildTranscriptSummary([], speakerData);
    expect(summary).toBe("");
  });

  it("falls back to speaker label when not in speakerData", () => {
    const seg: TranscriptSegment[] = [
      { id: "x", start_time: "0.0", end_time: "5.0", transcript: "Hi", speaker_label: "spk_99" },
    ];
    const summary = buildTranscriptSummary(seg, {});
    expect(summary).toContain("[spk_99]");
  });
});

describe("createDefaultChapters", () => {
  it("creates 3 chapters covering the full duration", () => {
    const chapters = createDefaultChapters(EPISODE_ID, 600);
    expect(chapters).toHaveLength(3);
    expect(chapters[0].episodeStartSec).toBe(0);
    expect(chapters[chapters.length - 1].episodeEndSec).toBe(600);
  });

  it("assigns the correct types in order", () => {
    const chapters = createDefaultChapters(EPISODE_ID, 600);
    expect(chapters[0].type).toBe("introduction");
    expect(chapters[1].type).toBe("section");
    expect(chapters[2].type).toBe("credits");
  });

  it("all chapters have the correct episodeId", () => {
    const chapters = createDefaultChapters(EPISODE_ID, 3600);
    for (const ch of chapters) {
      expect(ch.episodeId).toBe(EPISODE_ID);
    }
  });

  it("handles short episodes without negative durations", () => {
    const chapters = createDefaultChapters(EPISODE_ID, 30);
    expect(chapters[0].episodeStartSec).toBe(0);
    expect(chapters[chapters.length - 1].episodeEndSec).toBe(30);
    for (const ch of chapters) {
      expect(ch.episodeEndSec).toBeGreaterThanOrEqual(ch.episodeStartSec);
    }
  });
});

describe("validateAndFixChapters", () => {
  it("returns default chapters for empty input", () => {
    const result = validateAndFixChapters([], 600, EPISODE_ID);
    expect(result.length).toBeGreaterThan(0);
  });

  it("forces first chapter to start at 0", () => {
    const chapters: Chapter[] = [
      { id: "c1", episodeId: EPISODE_ID, type: "section", title: "A", summary: null, episodeStartSec: 10, episodeEndSec: 300 },
      { id: "c2", episodeId: EPISODE_ID, type: "section", title: "B", summary: null, episodeStartSec: 300, episodeEndSec: 600 },
    ];
    const result = validateAndFixChapters(chapters, 600, EPISODE_ID);
    expect(result[0].episodeStartSec).toBe(0);
  });

  it("forces last chapter to end at duration", () => {
    const chapters: Chapter[] = [
      { id: "c1", episodeId: EPISODE_ID, type: "section", title: "A", summary: null, episodeStartSec: 0, episodeEndSec: 300 },
      { id: "c2", episodeId: EPISODE_ID, type: "section", title: "B", summary: null, episodeStartSec: 300, episodeEndSec: 550 },
    ];
    const result = validateAndFixChapters(chapters, 600, EPISODE_ID);
    expect(result[result.length - 1].episodeEndSec).toBe(600);
  });

  it("closes gaps between chapters", () => {
    const chapters: Chapter[] = [
      { id: "c1", episodeId: EPISODE_ID, type: "section", title: "A", summary: null, episodeStartSec: 0, episodeEndSec: 200 },
      { id: "c2", episodeId: EPISODE_ID, type: "section", title: "B", summary: null, episodeStartSec: 250, episodeEndSec: 600 },
    ];
    const result = validateAndFixChapters(chapters, 600, EPISODE_ID);
    expect(result[1].episodeStartSec).toBe(result[0].episodeEndSec);
  });

  it("filters out chapters that are too short after adjustments", () => {
    const chapters: Chapter[] = [
      { id: "c1", episodeId: EPISODE_ID, type: "section", title: "A", summary: null, episodeStartSec: 0, episodeEndSec: 5 },
      { id: "c2", episodeId: EPISODE_ID, type: "section", title: "B", summary: null, episodeStartSec: 5, episodeEndSec: 600 },
    ];
    const result = validateAndFixChapters(chapters, 600, EPISODE_ID);
    const short = result.filter((c) => c.episodeEndSec - c.episodeStartSec < 10);
    expect(short).toHaveLength(0);
  });
});
