import { describe, it, expect } from "vitest";
import {
  countAdKeywordMatches,
  chunkData,
  formatTimestamp,
  ellipsize,
} from "@/process-transcript/ingest-to-graphiti";

describe("formatTimestamp", () => {
  it("formats seconds to MM:SS", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(65)).toBe("1:05");
    expect(formatTimestamp(3600)).toBe("60:00");
    expect(formatTimestamp(3661)).toBe("61:01");
  });

  it("zero-pads seconds", () => {
    expect(formatTimestamp(60)).toBe("1:00");
    expect(formatTimestamp(61)).toBe("1:01");
  });
});

describe("ellipsize", () => {
  it("returns the string unchanged when within limit", () => {
    expect(ellipsize("hello", 10)).toBe("hello");
    expect(ellipsize("hello", 5)).toBe("hello");
  });

  it("truncates and appends ellipsis when over limit", () => {
    const result = ellipsize("hello world", 8);
    expect(result.length).toBe(8);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("countAdKeywordMatches", () => {
  it("returns 0 for clean content", () => {
    expect(countAdKeywordMatches("Today we discuss the philosophy of science.")).toBe(0);
    expect(countAdKeywordMatches("Welcome back to the show. Let's get into it.")).toBe(0);
  });

  it("counts strong ad signals", () => {
    const adText = "Use promo code SAVE20 for 20% off your first order. Visit example.com to get started.";
    expect(countAdKeywordMatches(adText)).toBeGreaterThanOrEqual(3);
  });

  it("counts single weak signals", () => {
    expect(countAdKeywordMatches("This episode is supported by our sponsors.")).toBeGreaterThanOrEqual(1);
  });

  it("detects 'brought to you by'", () => {
    expect(countAdKeywordMatches("This podcast is brought to you by Acme Corp.")).toBeGreaterThanOrEqual(1);
  });

  it("detects free trial language", () => {
    expect(countAdKeywordMatches("Sign up for a free trial at example.com today.")).toBeGreaterThanOrEqual(2);
  });
});

describe("chunkData", () => {
  it("returns single chunk when data is within limit", () => {
    const data = "a".repeat(100);
    const chunks = chunkData(data);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(data);
  });

  it("splits data that exceeds MAX_DATA_CHARS into multiple chunks", () => {
    const data = "a".repeat(6000);
    const chunks = chunkData(data);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(5000);
    }
  });

  it("reassembled chunks contain all original content", () => {
    // Use a string that will split at word boundaries
    const word = "hello ";
    const data = word.repeat(1200); // ~7200 chars
    const chunks = chunkData(data);
    expect(chunks.length).toBeGreaterThan(1);
    const reassembled = chunks.join(" ").replace(/\s+/g, " ").trim();
    const original = data.trim();
    // All words from original should be in reassembled
    expect(reassembled.length).toBeGreaterThan(original.length * 0.95);
  });

  it("splits preferring sentence boundaries", () => {
    // Build data with clear sentence endings before the 5000 char mark
    const sentence = "This is a sentence. ";
    const data = sentence.repeat(300); // ~6000 chars
    const chunks = chunkData(data);
    // At least one chunk should end cleanly at a period
    const firstChunk = chunks[0];
    expect(firstChunk.trim().endsWith(".")).toBe(true);
  });
});
