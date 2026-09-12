/**
 * Verify an episode's published HLS output against docs/hls-output-spec.md.
 *
 * Reads the playlists and the object listing from S3, probes one segment, and
 * reports a pass or fail line per requirement in the spec. Nothing is written.
 *
 * Usage:
 *   AWS_PROFILE=pond npx tsx scripts/verify-hls-output.ts <audioMediaId>
 *   AWS_PROFILE=pond npx tsx scripts/verify-hls-output.ts <audioMediaId> --bucket audiopond-media-production
 *   AWS_PROFILE=pond npx tsx scripts/verify-hls-output.ts <audioMediaId> --prefix scratch/measure/<id>/hls/
 *
 * Defaults to the dev bucket and the prefix from generate-hls-subtitles/paths.ts.
 * Requires ffprobe on PATH.
 */

import { spawn } from "node:child_process";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  audioPlaylistKey,
  hlsPrefix,
  masterManifestKey,
} from "../packages/functions/src/generate-hls-subtitles/paths";

const s3 = new S3Client({});

const DEFAULT_BUCKET = "narrows-media-dev";
const TARGET_BITRATE_BPS = 128_000;
const TARGET_SEGMENT_SEC = 10;
const MAX_SEGMENT_SEC = 10.1;
const MIN_FULL_SEGMENT_SEC = 9.5;
const PRESIGN_EXPIRY_SEC = 300;

/**
 * Applied to the audio stream's own rate, not the rate derived from segment bytes.
 * The stream rate is what the requirement is about and is the same in either
 * container; bytes on disk are not, because MPEG-TS packetisation and padding add
 * roughly 15% that raw ADTS does not. 10% is loose enough for the encoder varying
 * frame sizes and tight enough to catch an episode encoded at 96 or 192 kbps.
 */
const BITRATE_TOLERANCE = 0.1;

interface CliOptions {
  audioMediaId: string;
  bucket: string;
  prefix: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const audioMediaId = args.find((a) => !a.startsWith("--"));

  if (!audioMediaId) {
    console.error(
      "usage: npx tsx scripts/verify-hls-output.ts <audioMediaId> [--bucket b] [--prefix p]"
    );
    process.exit(2);
  }

  const flag = (name: string, fallback: string): string => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? fallback : (args[index + 1] ?? fallback);
  };

  return {
    audioMediaId,
    bucket: flag("bucket", DEFAULT_BUCKET),
    prefix: flag("prefix", hlsPrefix(audioMediaId)),
  };
}

interface CheckResult {
  name: string;
  passed: boolean;
}

const results: CheckResult[] = [];

function check(name: string, passed: boolean, detail?: string): boolean {
  results.push({ name, passed });
  const suffix = detail ? `: ${detail}` : "";
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${suffix}`);
  return passed;
}

function info(message: string): void {
  console.log(`INFO ${message}`);
}

async function listPrefix(bucket: string, prefix: string): Promise<Map<string, number>> {
  const objects = new Map<string, number>();
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    for (const object of response.Contents ?? []) {
      if (object.Key) objects.set(object.Key, object.Size ?? 0);
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return objects;
}

async function getText(bucket: string, key: string): Promise<string> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return (await response.Body?.transformToString()) ?? "";
}

interface PlaylistEntry {
  durationSec: number;
  filename: string;
}

function parseEntries(playlist: string): PlaylistEntry[] {
  const entries: PlaylistEntry[] = [];
  let pendingDuration: number | null = null;

  for (const rawLine of playlist.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const extinf = /^#EXTINF:([\d.]+)/.exec(line);
    if (extinf) {
      pendingDuration = Number.parseFloat(extinf[1]);
      continue;
    }

    if (line.startsWith("#")) continue;

    entries.push({
      durationSec: pendingDuration ?? Number.NaN,
      filename: line.split("/").pop() ?? line,
    });
    pendingDuration = null;
  }

  return entries;
}

interface ProbedSegment {
  codecName: string;
  profile: string;
  sampleRate: number;
  channels: number;
  bitrateBps: number;
  formatName: string;
}

async function probeSegment(url: string): Promise<ProbedSegment> {
  const args = [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name,profile,sample_rate,channels,bit_rate:format=format_name",
    "-of",
    "json",
    url,
  ];

  const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: string[] = [];
  child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => stderrChunks.push(c));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`ffprobe exited with code ${exitCode}: ${stderrChunks.join("")}`);
  }

  const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as {
    streams?: Array<{
      codec_name?: string;
      profile?: string;
      sample_rate?: string;
      channels?: number;
      bit_rate?: string;
    }>;
    format?: { format_name?: string };
  };

  const stream = parsed.streams?.[0];
  if (!stream) {
    throw new Error("ffprobe found no audio stream in the segment");
  }

  return {
    codecName: stream.codec_name ?? "unknown",
    profile: stream.profile ?? "unknown",
    sampleRate: Number(stream.sample_rate ?? 0),
    channels: stream.channels ?? 0,
    bitrateBps: Number(stream.bit_rate ?? 0),
    formatName: parsed.format?.format_name ?? "unknown",
  };
}

function summarise(segmentCount: number, totalDurationSec: number): never {
  const failed = results.filter((r) => !r.passed).length;
  const minutes = Math.floor(totalDurationSec / 60);
  const seconds = (totalDurationSec % 60).toFixed(1);

  console.log(
    `\n${results.length} checks, ${results.length - failed} passed, ${failed} failed. ` +
      `${segmentCount} segments, ${totalDurationSec.toFixed(3)}s total duration (${minutes}m${seconds}s).`
  );
  console.log(failed === 0 ? "PASS" : "FAIL");
  process.exit(failed === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  const { audioMediaId, bucket, prefix } = parseArgs();
  const defaultPrefix = hlsPrefix(audioMediaId);
  const masterFilename = masterManifestKey(audioMediaId).slice(defaultPrefix.length);
  const mediaFilename = audioPlaylistKey(audioMediaId).slice(defaultPrefix.length);
  const masterKey = `${prefix}${masterFilename}`;
  const mediaKey = `${prefix}${mediaFilename}`;

  console.log(`Verifying s3://${bucket}/${prefix}\n`);

  // The listing is fetched once and every existence check compares against it.
  // An episode has up to ~1600 segments, and a HeadObject each would be ~1600
  // sequential round trips for information one paginated listing already holds.
  const objects = await listPrefix(bucket, prefix);

  const masterExists = check("master playlist exists", objects.has(masterKey), masterKey);
  const mediaExists = check("media playlist exists", objects.has(mediaKey), mediaKey);

  if (!mediaExists) {
    summarise(0, 0);
  }

  if (masterExists) {
    const master = await getText(bucket, masterKey);
    check(
      "master playlist references the media playlist",
      master.includes(mediaFilename),
      mediaFilename
    );
  }

  const media = await getText(bucket, mediaKey);
  const isVod = media.includes("#EXT-X-PLAYLIST-TYPE:VOD");
  const hasEndList = media.trim().endsWith("#EXT-X-ENDLIST");
  check(
    "media playlist is VOD and ends with EXT-X-ENDLIST",
    isVod && hasEndList,
    `EXT-X-PLAYLIST-TYPE:VOD ${isVod ? "present" : "missing"}, EXT-X-ENDLIST ${hasEndList ? "last line" : "missing or not last"}`
  );

  const entries = parseEntries(media);
  const totalDurationSec = entries.reduce((sum, entry) => sum + entry.durationSec, 0);

  const segmentPattern = new RegExp(`^${audioMediaId}_audio_(\\d{5})\\.(ts|aac)$`);
  const objectSegments = new Set<string>();
  for (const key of objects.keys()) {
    const filename = key.slice(prefix.length);
    if (segmentPattern.test(filename)) objectSegments.add(filename);
  }

  const missing = entries.filter((entry) => !objectSegments.has(entry.filename));
  check(
    "every segment in the playlist exists in S3",
    missing.length === 0,
    missing.length === 0
      ? `${entries.length} segments`
      : `${missing.length} missing, first ${missing[0].filename}`
  );

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.filename)) duplicates.add(entry.filename);
    seen.add(entry.filename);
  }
  check(
    "no segment is referenced twice",
    duplicates.size === 0,
    duplicates.size === 0 ? "" : `${duplicates.size} duplicated, first ${[...duplicates][0]}`
  );

  const orphans = [...objectSegments].filter((filename) => !seen.has(filename)).sort();
  check(
    "no segment object is missing from the playlist",
    orphans.length === 0,
    orphans.length === 0 ? `${objectSegments.size} objects` : `${orphans.length} orphaned, first ${orphans[0]}`
  );

  const numbers = entries.map((entry) => {
    const match = segmentPattern.exec(entry.filename);
    return match ? Number.parseInt(match[1], 10) : Number.NaN;
  });
  // ffmpeg numbers from 00000 and MediaConvert from 00001, so the start index is
  // read from the playlist rather than assumed. What matters is that the sequence
  // has no gaps: a missing number means a segment was lost between transcode and
  // upload, and the client would hit a 404 mid-episode.
  const firstNumber = numbers[0];
  const gaps = numbers.filter((n, index) => n !== firstNumber + index);
  const validStart = firstNumber === 0 || firstNumber === 1;
  check(
    "segment numbering is contiguous",
    gaps.length === 0 && validStart,
    gaps.length > 0
      ? `${gaps.length} out of sequence, first ${String(gaps[0]).padStart(5, "0")}`
      : validStart
        ? `${String(firstNumber).padStart(5, "0")} to ${String(firstNumber + numbers.length - 1).padStart(5, "0")}`
        : `starts at ${String(firstNumber).padStart(5, "0")}, expected 00000 or 00001`
  );

  const middle = entries[Math.floor(entries.length / 2)];
  const middleUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: `${prefix}${middle.filename}` }),
    { expiresIn: PRESIGN_EXPIRY_SEC }
  );
  const probed = await probeSegment(middleUrl);
  const encodingCorrect =
    probed.codecName === "aac" &&
    probed.profile === "LC" &&
    probed.sampleRate === 48_000 &&
    probed.channels === 2;
  check(
    "segment encoding is AAC-LC 48000 Hz stereo",
    encodingCorrect,
    `${middle.filename} is ${probed.codecName} ${probed.profile} ${probed.sampleRate}Hz ${probed.channels}ch`
  );

  const totalBytes = entries.reduce(
    (sum, entry) => sum + (objects.get(`${prefix}${entry.filename}`) ?? 0),
    0
  );
  const containerBps = totalDurationSec > 0 ? (totalBytes * 8) / totalDurationSec : 0;
  const drift = probed.bitrateBps / TARGET_BITRATE_BPS - 1;
  check(
    "audio bitrate is approximately 128 kbps",
    probed.bitrateBps > 0 && Math.abs(drift) <= BITRATE_TOLERANCE,
    probed.bitrateBps > 0
      ? `${(probed.bitrateBps / 1000).toFixed(1)} kbps audio stream, ${(drift * 100).toFixed(1)}% from target, tolerance ${(BITRATE_TOLERANCE * 100).toFixed(0)}%`
      : "ffprobe reported no stream bitrate"
  );
  console.log(
    `INFO ${(containerBps / 1000).toFixed(1)} kbps including container overhead, over ${totalBytes} bytes`
  );

  const durations = entries.map((entry) => entry.durationSec);
  const fullDurations = durations.length > 1 ? durations.slice(0, -1) : durations;
  const tooLong = durations.filter((d) => d > MAX_SEGMENT_SEC);
  const tooShort = fullDurations.filter((d) => d < MIN_FULL_SEGMENT_SEC);
  check(
    "segment durations are within tolerance of 10 s",
    tooLong.length === 0 && tooShort.length === 0,
    `min ${Math.min(...fullDurations).toFixed(3)}s, max ${Math.max(...durations).toFixed(3)}s, last ${durations[durations.length - 1].toFixed(3)}s, target ${TARGET_SEGMENT_SEC}s`
  );

  info(`container is ${probed.formatName}; the spec allows mpegts and ADTS`);

  summarise(entries.length, totalDurationSec);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
