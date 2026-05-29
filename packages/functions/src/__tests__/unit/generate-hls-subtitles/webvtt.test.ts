import { describe, it, expect } from "vitest";
import {
  buildSentences,
  buildSubtitlePlaylist,
  generateSubtitleSegments,
  masterManifestHasSubtitles,
  parseAudioPlaylist,
  patchMasterManifest,
  type TranscriptItem,
} from "@/generate-hls-subtitles/webvtt";

function word(content: string, start: string, end: string): TranscriptItem {
  return {
    start_time: start,
    end_time: end,
    type: "pronunciation",
    alternatives: [{ confidence: "0.9", content }],
    speaker_label: "spk_0",
  };
}

function punct(content: string, time: string): TranscriptItem {
  return {
    start_time: time,
    end_time: time,
    type: "punctuation",
    alternatives: [{ confidence: "0.0", content }],
  };
}

describe("buildSentences", () => {
  it("splits on sentence-ending punctuation", () => {
    const items = [
      word("Hello", "0", "0.5"),
      word("world", "0.5", "1"),
      punct(".", "1"),
      word("How", "1.5", "2"),
      word("are", "2", "2.5"),
      word("you", "2.5", "3"),
      punct("?", "3"),
    ];

    const sentences = buildSentences(items);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toMatchObject({
      text: "Hello world.",
      startTime: 0,
      endTime: 1,
    });
    expect(sentences[1]).toMatchObject({
      text: "How are you?",
      startTime: 1.5,
      endTime: 3,
    });
  });

  it("force-splits after 60 words without sentence ender", () => {
    const items: TranscriptItem[] = [];
    for (let i = 0; i < 61; i++) {
      items.push(word(`word${i}`, String(i), String(i + 0.5)));
    }

    const sentences = buildSentences(items);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array for empty input", () => {
    expect(buildSentences([])).toEqual([]);
  });

  it("appends punctuation without leading space", () => {
    const items = [word("Yes", "0", "0.5"), punct(",", "0.5"), word("please", "0.6", "1")];
    const sentences = buildSentences(items);
    expect(sentences[0].text).toBe("Yes, please");
  });
});

describe("parseAudioPlaylist", () => {
  it("parses EXTINF durations into cumulative boundaries", () => {
    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.005333,
segment00001.ts
#EXTINF:10.005333,
segment00002.ts
#EXTINF:5.500000,
segment00003.ts
#EXT-X-ENDLIST`;

    const boundaries = parseAudioPlaylist(playlist);
    expect(boundaries).toHaveLength(3);
    expect(boundaries[0]).toMatchObject({ index: 0, startSec: 0, endSec: 10.005333 });
    expect(boundaries[1]).toMatchObject({
      index: 1,
      startSec: 10.005333,
      endSec: 20.010666,
    });
    expect(boundaries[2]).toMatchObject({
      index: 2,
      startSec: 20.010666,
      endSec: 25.510666,
    });
  });
});

describe("generateSubtitleSegments", () => {
  it("includes sentences overlapping segment window", () => {
    const sentences = [
      { text: "First sentence.", startTime: 5, endTime: 8 },
      { text: "Second sentence.", startTime: 12, endTime: 15 },
    ];
    const boundaries = [
      { index: 0, startSec: 0, endSec: 10, durationSec: 10 },
      { index: 1, startSec: 10, endSec: 20, durationSec: 10 },
    ];

    const segments = generateSubtitleSegments(sentences, boundaries);
    expect(segments).toHaveLength(2);
    expect(segments[0].content).toContain("First sentence.");
    expect(segments[0].content).not.toContain("Second sentence.");
    expect(segments[1].content).toContain("Second sentence.");
    expect(segments[0].content).toContain("X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0");
    expect(segments[1].content).toContain("MPEGTS:900000");
  });

  it("duplicates cues spanning segment boundaries", () => {
    const sentences = [{ text: "Long spanning sentence.", startTime: 8, endTime: 12 }];
    const boundaries = [
      { index: 0, startSec: 0, endSec: 10, durationSec: 10 },
      { index: 1, startSec: 10, endSec: 20, durationSec: 10 },
    ];

    const segments = generateSubtitleSegments(sentences, boundaries);
    expect(segments[0].content).toContain("Long spanning sentence.");
    expect(segments[1].content).toContain("Long spanning sentence.");
  });
});

describe("buildSubtitlePlaylist", () => {
  it("mirrors audio segment durations", () => {
    const boundaries = [
      { index: 0, startSec: 0, endSec: 10, durationSec: 10.005333 },
      { index: 1, startSec: 10, endSec: 20, durationSec: 10.005333 },
    ];

    const playlist = buildSubtitlePlaylist(boundaries);
    expect(playlist).toContain("#EXTINF:10.005333,");
    expect(playlist).toContain("transcript_00001.vtt");
    expect(playlist).toContain("transcript_00002.vtt");
    expect(playlist).toContain("#EXT-X-ENDLIST");
  });
});

describe("patchMasterManifest", () => {
  const original = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"
abc123_audio.m3u8
`;

  it("adds subtitle media line and SUBTITLES attribute", () => {
    const patched = patchMasterManifest(original);
    expect(patched).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs"');
    expect(patched).toContain('SUBTITLES="subs"');
    expect(patched).toContain("URI=\"transcript.m3u8\"");
  });

  it("returns null when already patched", () => {
    const already = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="transcript.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=128000,SUBTITLES="subs"
abc123_audio.m3u8
`;
    expect(patchMasterManifest(already)).toBeNull();
    expect(masterManifestHasSubtitles(already)).toBe(true);
  });
});
