import { describe, it, expect } from "vitest";
import {
  getTranscriptForRange,
  assignChapterToSegment,
  targetSegmentCount,
  MIN_EPISODE_SEGMENTS,
  MAX_EPISODE_SEGMENTS,
  SEGMENTS_PER_HOUR,
} from "@/process-transcript/identify-segments";
import type { TranscriptSegment, SpeakerData, Chapter } from "@/process-transcript/types";

const speakerData: SpeakerData = {
  spk_0: { name: "Alice", role: "host" },
  spk_1: { name: "Bob", role: "guest" },
};

const segments: TranscriptSegment[] = [
  { id: "s1", start_time: "0.0", end_time: "30.0", transcript: "Opening.", speaker_label: "spk_0" },
  { id: "s2", start_time: "30.0", end_time: "60.0", transcript: "Main content.", speaker_label: "spk_1" },
  { id: "s3", start_time: "60.0", end_time: "90.0", transcript: "Conclusion.", speaker_label: "spk_0" },
];

const chapters: Chapter[] = [
  {
    id: "ch1",
    episodeId: "ep1",
    type: "introduction",
    title: "Intro",
    summary: null,
    episodeStartSec: 0,
    episodeEndSec: 50,
  },
  {
    id: "ch2",
    episodeId: "ep1",
    type: "section",
    title: "Main",
    summary: null,
    episodeStartSec: 50,
    episodeEndSec: 100,
  },
];

describe("targetSegmentCount", () => {
  it("uses ~15 segments per hour", () => {
    expect(SEGMENTS_PER_HOUR).toBe(15);
    // 1 hour → 15
    expect(targetSegmentCount(3600)).toBe(15);
    // 2 hours → 30 (hits max clamp)
    expect(targetSegmentCount(7200)).toBe(MAX_EPISODE_SEGMENTS);
  });

  it("clamps to MIN_EPISODE_SEGMENTS for short episodes", () => {
    // 10 minutes → round(10/60 * 15) = 3 → clamp to 8
    expect(targetSegmentCount(600)).toBe(MIN_EPISODE_SEGMENTS);
  });

  it("clamps to MAX_EPISODE_SEGMENTS for long episodes", () => {
    // 3 hours → 45 → clamp to 30
    expect(targetSegmentCount(3 * 3600)).toBe(MAX_EPISODE_SEGMENTS);
  });

  it("scales linearly within the clamp range", () => {
    // 90 minutes → round(1.5 * 15) = 23
    expect(targetSegmentCount(90 * 60)).toBe(23);
  });
});

describe("getTranscriptForRange", () => {
  it("returns text for segments fully within range", () => {
    const text = getTranscriptForRange(segments, 0, 30, speakerData);
    expect(text).toContain("[Alice]");
    expect(text).toContain("Opening.");
  });

  it("excludes segments outside the range", () => {
    const text = getTranscriptForRange(segments, 0, 30, speakerData);
    expect(text).not.toContain("Conclusion.");
  });

  it("includes speaker names from speakerData", () => {
    const text = getTranscriptForRange(segments, 30, 60, speakerData);
    expect(text).toContain("[Bob]");
    expect(text).toContain("Main content.");
  });

  it("falls back to speaker label when not in speakerData", () => {
    const extraSeg: TranscriptSegment[] = [
      { id: "x1", start_time: "0.0", end_time: "10.0", transcript: "Hi", speaker_label: "spk_99" },
    ];
    const text = getTranscriptForRange(extraSeg, 0, 10, {});
    expect(text).toContain("[spk_99]");
  });

  it("returns empty string when no segments match the range", () => {
    const text = getTranscriptForRange(segments, 200, 300, speakerData);
    expect(text).toBe("");
  });
});

describe("assignChapterToSegment", () => {
  it("assigns a segment to the chapter containing its midpoint", () => {
    // midpoint of 0-40 = 20, which falls in ch1 (0-50)
    expect(assignChapterToSegment(0, 40, chapters)).toBe("ch1");
  });

  it("assigns to chapter 2 when midpoint falls there", () => {
    // midpoint of 50-90 = 70, falls in ch2 (50-100)
    expect(assignChapterToSegment(50, 90, chapters)).toBe("ch2");
  });

  it("returns null when midpoint falls outside all chapters", () => {
    expect(assignChapterToSegment(100, 200, chapters)).toBeNull();
  });

  it("correctly handles segment straddling two chapters — assigns by midpoint", () => {
    // midpoint of 0-100 = 50, which is ch2.start (exclusive of ch1 since ch1 ends at 50)
    const result = assignChapterToSegment(0, 100, chapters);
    expect(result).toBe("ch2");
  });
});
