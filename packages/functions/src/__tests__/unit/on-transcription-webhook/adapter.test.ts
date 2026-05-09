import { describe, it, expect } from "vitest";
import {
  mapSpeaker,
  msToSecondsString,
  synthesizeItems,
  buildAudioSegments,
  adaptToTranscriptResult,
} from "@/on-transcription-webhook/adapter";
import type { AssemblyAIWord, AssemblyAISentence } from "@/on-transcription-webhook/types";

// ─── mapSpeaker ──────────────────────────────────────────────────────────────

describe("mapSpeaker", () => {
  it('maps "A" to "spk_0"', () => {
    expect(mapSpeaker("A")).toBe("spk_0");
  });

  it('maps "B" to "spk_1"', () => {
    expect(mapSpeaker("B")).toBe("spk_1");
  });

  it('maps "C" to "spk_2"', () => {
    expect(mapSpeaker("C")).toBe("spk_2");
  });

  it("maps null to spk_0", () => {
    expect(mapSpeaker(null)).toBe("spk_0");
  });
});

// ─── msToSecondsString ───────────────────────────────────────────────────────

describe("msToSecondsString", () => {
  it("converts whole seconds", () => {
    expect(msToSecondsString(5000)).toBe("5");
  });

  it("converts fractional seconds", () => {
    expect(msToSecondsString(5230)).toBe("5.23");
  });

  it("converts 0", () => {
    expect(msToSecondsString(0)).toBe("0");
  });

  it("converts single millisecond precision", () => {
    expect(msToSecondsString(1500)).toBe("1.5");
  });
});

// ─── synthesizeItems ─────────────────────────────────────────────────────────

describe("synthesizeItems", () => {
  const word = (
    text: string,
    start = 1000,
    end = 1500,
    speaker: string | null = "A",
    confidence = 0.97
  ): AssemblyAIWord => ({ text, start, end, confidence, speaker });

  it("emits a single pronunciation item for a plain word", () => {
    const items = synthesizeItems([word("hello")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "pronunciation",
      alternatives: [{ confidence: "0.97", content: "hello" }],
      speaker_label: "spk_0",
      start_time: "1",
      end_time: "1.5",
    });
  });

  it("strips trailing period and emits separate punctuation item", () => {
    const items = synthesizeItems([word("hello.")]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "pronunciation",
      alternatives: [{ confidence: "0.97", content: "hello" }],
    });
    expect(items[1]).toMatchObject({
      type: "punctuation",
      alternatives: [{ confidence: "0.0", content: "." }],
    });
  });

  it("strips trailing question mark", () => {
    const items = synthesizeItems([word("really?")]);
    expect(items).toHaveLength(2);
    expect(items[0].alternatives[0].content).toBe("really");
    expect(items[1].alternatives[0].content).toBe("?");
  });

  it("strips trailing exclamation mark", () => {
    const items = synthesizeItems([word("wow!")]);
    expect(items).toHaveLength(2);
    expect(items[0].alternatives[0].content).toBe("wow");
    expect(items[1].alternatives[0].content).toBe("!");
  });

  it("strips multiple trailing punctuation chars (e.g. '?!')", () => {
    const items = synthesizeItems([word("really?!")]);
    expect(items).toHaveLength(3);
    expect(items[0].alternatives[0].content).toBe("really");
    expect(items[1].alternatives[0].content).toBe("?");
    expect(items[2].alternatives[0].content).toBe("!");
  });

  it("strips comma", () => {
    const items = synthesizeItems([word("hello,")]);
    expect(items).toHaveLength(2);
    expect(items[0].alternatives[0].content).toBe("hello");
    expect(items[1].alternatives[0].content).toBe(",");
  });

  it("punctuation items use the word end_time for both start and end", () => {
    const items = synthesizeItems([word("hello.", 1000, 1500)]);
    expect(items[1]).toMatchObject({
      start_time: "1.5",
      end_time: "1.5",
    });
  });

  it("punctuation items have no speaker_label", () => {
    const items = synthesizeItems([word("hello.")]);
    expect(items[1].speaker_label).toBeUndefined();
  });

  it("handles null speaker by mapping to spk_0", () => {
    const items = synthesizeItems([word("hello", 1000, 1500, null)]);
    expect(items[0].speaker_label).toBe("spk_0");
  });

  it("handles multiple words in sequence", () => {
    const words = [word("Hello,", 0, 400), word("world.", 500, 900)];
    const items = synthesizeItems(words);
    expect(items).toHaveLength(4);
    expect(items[0].alternatives[0].content).toBe("Hello");
    expect(items[1].alternatives[0].content).toBe(",");
    expect(items[2].alternatives[0].content).toBe("world");
    expect(items[3].alternatives[0].content).toBe(".");
  });

  it("handles empty word list", () => {
    expect(synthesizeItems([])).toEqual([]);
  });
});

// ─── buildAudioSegments ──────────────────────────────────────────────────────

describe("buildAudioSegments", () => {
  const sentence = (
    text: string,
    start: number,
    end: number,
    speaker: string | null = "A"
  ): AssemblyAISentence => ({ text, start, end, speaker, confidence: 0.95, words: [] });

  it("maps a single sentence to an audio segment", () => {
    const segments = buildAudioSegments([sentence("Hello world.", 0, 5230)]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      id: "0",
      start_time: "0",
      end_time: "5.23",
      transcript: "Hello world.",
      speaker_label: "spk_0",
    });
  });

  it("uses sequential string IDs", () => {
    const segs = buildAudioSegments([
      sentence("First.", 0, 1000),
      sentence("Second.", 1000, 2000),
      sentence("Third.", 2000, 3000),
    ]);
    expect(segs.map((s) => s.id)).toEqual(["0", "1", "2"]);
  });

  it("maps speaker B to spk_1", () => {
    const segs = buildAudioSegments([sentence("Hello.", 0, 1000, "B")]);
    expect(segs[0].speaker_label).toBe("spk_1");
  });

  it("handles null speaker", () => {
    const segs = buildAudioSegments([sentence("No speaker.", 0, 1000, null)]);
    expect(segs[0].speaker_label).toBe("spk_0");
  });

  it("returns empty array for empty input", () => {
    expect(buildAudioSegments([])).toEqual([]);
  });
});

// ─── adaptToTranscriptResult ─────────────────────────────────────────────────

describe("adaptToTranscriptResult", () => {
  it("produces the expected TranscriptResult shape", () => {
    const words: AssemblyAIWord[] = [
      { text: "Hello,", start: 0, end: 400, confidence: 0.99, speaker: "A" },
      { text: "world.", start: 500, end: 900, confidence: 0.98, speaker: "A" },
    ];
    const sentences: AssemblyAISentence[] = [
      {
        text: "Hello, world.",
        start: 0,
        end: 900,
        confidence: 0.98,
        speaker: "A",
        words,
      },
    ];

    const result = adaptToTranscriptResult(words, sentences);

    // Shape is correct
    expect(result).toHaveProperty("results.audio_segments");
    expect(result).toHaveProperty("results.items");

    // One audio_segment for the one sentence
    expect(result.results.audio_segments).toHaveLength(1);
    expect(result.results.audio_segments[0]).toMatchObject({
      id: "0",
      transcript: "Hello, world.",
      speaker_label: "spk_0",
    });

    // items: Hello + , + world + .  = 4
    expect(result.results.items).toHaveLength(4);
    expect(result.results.items[0]).toMatchObject({
      type: "pronunciation",
      alternatives: [{ content: "Hello" }],
    });
    expect(result.results.items[1]).toMatchObject({
      type: "punctuation",
      alternatives: [{ content: "," }],
    });
  });

  it("handles empty arrays without throwing", () => {
    const result = adaptToTranscriptResult([], []);
    expect(result.results.audio_segments).toEqual([]);
    expect(result.results.items).toEqual([]);
  });
});
