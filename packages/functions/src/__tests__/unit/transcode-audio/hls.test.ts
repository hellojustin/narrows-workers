import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  AUDIO_BITRATE,
  AUDIO_CHANNELS,
  AUDIO_CODEC,
  AUDIO_SAMPLE_RATE,
  SEGMENT_SECONDS,
  audioPlaylistName,
  buildHlsArgs,
  masterPlaylistName,
  segmentPattern,
  transcodeToHls,
  verifyPlaylistAgainstSegments,
} from "../../../transcode-audio/hls";

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeWithFfmpeg = hasFfmpeg() ? describe : describe.skip;
const scratchDirs: string[] = [];

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hls-test-"));
  scratchDirs.push(dir);
  return dir;
}

describe("encoding settings", () => {
  it("matches the output specification", () => {
    // These are the requirement, not an implementation detail. If one changes,
    // docs/hls-output-spec.md is wrong and existing clients may be affected.
    expect(AUDIO_CODEC).toBe("aac");
    expect(AUDIO_BITRATE).toBe("128k");
    expect(AUDIO_SAMPLE_RATE).toBe(48_000);
    expect(AUDIO_CHANNELS).toBe(2);
    expect(SEGMENT_SECONDS).toBe(10);
  });
});

describe("output names", () => {
  const mediaId = "00035828-bbfd-4de9-9fdc-9438dbdeb60b";

  it("uses the key names the rest of the pipeline depends on", () => {
    // The fan-in HeadObjects the master playlist, and generate-hls-subtitles
    // reads the audio playlist. Changing either breaks the pipeline silently.
    expect(masterPlaylistName(mediaId)).toBe(`${mediaId}.m3u8`);
    expect(audioPlaylistName(mediaId)).toBe(`${mediaId}_audio.m3u8`);
    expect(segmentPattern(mediaId)).toBe(`${mediaId}_audio_%05d.ts`);
  });
});

describe("buildHlsArgs", () => {
  const args = buildHlsArgs({
    input: "https://example.test/raw/abc",
    outputDir: "/tmp/out",
    audioMediaId: "abc",
  });

  it("selects only the first audio stream", () => {
    // Podcast mp3s frequently carry cover art as a video stream.
    expect(args).toContain("-map");
    expect(args[args.indexOf("-map") + 1]).toBe("0:a:0");
  });

  it("requests the specified encoding", () => {
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
    expect(args[args.indexOf("-b:a") + 1]).toBe("128k");
    expect(args[args.indexOf("-ar") + 1]).toBe("48000");
    expect(args[args.indexOf("-ac") + 1]).toBe("2");
    expect(args[args.indexOf("-hls_time") + 1]).toBe("10");
  });

  it("keeps every segment in the playlist", () => {
    // The hls muxer defaults to a 5-entry sliding window, which would list only
    // the last five segments of a VOD stream.
    expect(args[args.indexOf("-hls_list_size") + 1]).toBe("0");
    expect(args[args.indexOf("-hls_playlist_type") + 1]).toBe("vod");
  });

  it("asks the muxer to write the master playlist", () => {
    expect(args[args.indexOf("-master_pl_name") + 1]).toBe("abc.m3u8");
  });
});

describe("verifyPlaylistAgainstSegments", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:11",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXTINF:10.005333,",
    "m_audio_00000.ts",
    "#EXTINF:10.005333,",
    "m_audio_00001.ts",
    "#EXTINF:3.500000,",
    "m_audio_00002.ts",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");

  const segments = ["m_audio_00000.ts", "m_audio_00001.ts", "m_audio_00002.ts"];

  it("counts segments and accumulates duration", () => {
    const result = verifyPlaylistAgainstSegments(playlist, segments);
    expect(result.segmentCount).toBe(3);
    expect(result.totalDurationSec).toBeCloseTo(23.510666, 5);
  });

  it("rejects a playlist referencing a segment that is not on disk", () => {
    expect(() => verifyPlaylistAgainstSegments(playlist, segments.slice(0, 2))).toThrow(
      /not on disk/
    );
  });

  it("rejects a segment on disk that the playlist never references", () => {
    expect(() =>
      verifyPlaylistAgainstSegments(playlist, [...segments, "m_audio_00003.ts"])
    ).toThrow(/not in the playlist/);
  });

  it("rejects duplicate segment references", () => {
    // This is the failure seen while testing parallel time-range chunking: two
    // chunks claimed the same segment number, so files overwrote each other and
    // the playlist listed more entries than existed.
    const collided = [
      "#EXTINF:10.005333,",
      "m_audio_00000.ts",
      "#EXTINF:10.005333,",
      "m_audio_00000.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");

    expect(() => verifyPlaylistAgainstSegments(collided, ["m_audio_00000.ts"])).toThrow(
      /duplicate/
    );
  });

  it("ignores playlists with no segments rather than reporting a false total", () => {
    const empty = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n";
    const result = verifyPlaylistAgainstSegments(empty, []);
    expect(result.segmentCount).toBe(0);
    expect(result.totalDurationSec).toBe(0);
  });
});

describeWithFfmpeg("transcodeToHls", () => {
  it("produces playlists and segments matching the specification", async () => {
    const outputDir = await scratch();
    const source = path.join(await scratch(), "source.wav");

    // 25 seconds of a 440 Hz tone, so we expect three segments: 10 + 10 + 5.
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=25",
      "-ac",
      "2",
      "-y",
      source,
    ]);

    const output = await transcodeToHls({
      input: source,
      outputDir,
      audioMediaId: "test-media",
    });

    expect(output.segmentNames.length).toBe(3);
    expect(output.masterPlaylistName).toBe("test-media.m3u8");
    expect(output.audioPlaylistName).toBe("test-media_audio.m3u8");

    const audioPlaylist = await readFile(path.join(outputDir, output.audioPlaylistName), "utf8");
    const check = verifyPlaylistAgainstSegments(audioPlaylist, output.segmentNames);
    expect(check.segmentCount).toBe(3);
    // Within one AAC frame (1024 samples at 48 kHz = 21.3 ms) of the source.
    expect(check.totalDurationSec).toBeGreaterThan(24.9);
    expect(check.totalDurationSec).toBeLessThan(25.1);

    // The master playlist must carry the line patchMasterManifest needs, or
    // subtitle generation throws.
    const master = await readFile(path.join(outputDir, output.masterPlaylistName), "utf8");
    expect(master).toContain("#EXT-X-STREAM-INF:");
    expect(master).toContain('CODECS="mp4a.40.2"');
    expect(master).toContain(output.audioPlaylistName);

    expect(audioPlaylist).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(audioPlaylist).toContain("#EXT-X-ENDLIST");
  }, 60_000);

  it("produces the encoding the specification requires", async () => {
    const outputDir = await scratch();
    const source = path.join(await scratch(), "source.wav");

    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=12",
      "-ac",
      "1",
      "-y",
      source,
    ]);

    const output = await transcodeToHls({ input: source, outputDir, audioMediaId: "mono-media" });

    // A mono 44.1 kHz source must still come out as stereo 48 kHz AAC-LC.
    const probe = execFileSync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,profile,sample_rate,channels",
      "-of",
      "json",
      path.join(outputDir, output.segmentNames[0]),
    ]).toString();

    const stream = JSON.parse(probe).streams[0];
    expect(stream.codec_name).toBe("aac");
    expect(Number(stream.sample_rate)).toBe(48_000);
    expect(stream.channels).toBe(2);
  }, 60_000);

  it("clears stale output rather than mixing two runs together", async () => {
    const outputDir = await scratch();
    const source = path.join(await scratch(), "source.wav");

    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=12",
      "-ac",
      "2",
      "-y",
      source,
    ]);

    // A leftover segment from a previous, longer episode. If the directory were
    // not cleared, it would be uploaded as part of this episode.
    await writeFile(path.join(outputDir, "stale-media_audio_09999.ts"), "stale");

    const output = await transcodeToHls({ input: source, outputDir, audioMediaId: "fresh-media" });
    expect(output.segmentNames.every((name) => name.startsWith("fresh-media"))).toBe(true);
  }, 60_000);
});
