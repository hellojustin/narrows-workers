#!/usr/bin/env node
/**
 * Verify that HLS output actually plays.
 *
 * Fetches an episode's HLS from S3, serves it over local HTTP, and plays it with
 * AVFoundation — the engine behind AVPlayer on iOS, so this exercises the same
 * demuxer and decoder path the iOS client uses. A browser check is weaker, because
 * HLS.js brings its own demuxer and would not catch a stream Apple's player rejects.
 *
 * The check plays from the start, after a seek to the middle, and at the end. The
 * mid-file seek is the part that matters: a segment container missing presentation
 * timestamps parses fine and plays from position zero, then fails to decode when
 * playback starts anywhere else.
 *
 *   node scripts/verify-playback.mjs <audioMediaId> [--bucket <name>] [--prefix <s3 prefix>]
 *
 * Defaults to the dev bucket. To check existing MediaConvert output:
 *
 *   node scripts/verify-playback.mjs <id> --bucket audiopond-media-production
 *
 * Requires AWS_PROFILE=pond, ffprobe, and swift.
 */

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const PORT = 8771;

const args = process.argv.slice(2);
const audioMediaId = args.find((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

if (!audioMediaId) {
  console.error("usage: node scripts/verify-playback.mjs <audioMediaId> [--bucket b] [--prefix p]");
  process.exit(2);
}

const bucket = flag("bucket", "narrows-media-dev");
const prefix = flag("prefix", `processed/${audioMediaId}/hls/`);

/** Total duration from the media playlist, which is what the player should report. */
function playlistDuration(content) {
  let total = 0;
  for (const line of content.split(/\r?\n/)) {
    const match = /^#EXTINF:([\d.]+)/.exec(line.trim());
    if (match) total += Number.parseFloat(match[1]);
  }
  return total;
}

async function main() {
  const workDir = await mkdtemp(path.join(tmpdir(), "playback-"));
  const hlsDir = path.join(workDir, "hls");

  try {
    console.log(`Fetching s3://${bucket}/${prefix}`);
    await run("aws", [
      "s3", "sync", `s3://${bucket}/${prefix}`, hlsDir,
      "--exclude", "transcript*", "--no-progress",
    ]);

    const entries = await readdir(hlsDir);
    const master = `${audioMediaId}.m3u8`;
    const media = `${audioMediaId}_audio.m3u8`;

    for (const required of [master, media]) {
      if (!entries.includes(required)) {
        throw new Error(`${required} is missing from ${prefix}`);
      }
    }

    const segments = entries.filter((e) => e.endsWith(".ts") || e.endsWith(".aac"));
    const mediaContent = await readFile(path.join(hlsDir, media), "utf8");
    const duration = playlistDuration(mediaContent);

    console.log(`  ${segments.length} segments, playlist duration ${duration.toFixed(3)}s`);

    // Encoding, read from the segment bytes rather than from what the playlist claims.
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_name,sample_rate,channels:format=format_name",
      "-of", "json", path.join(hlsDir, segments.sort()[0]),
    ]);
    const probed = JSON.parse(stdout);
    const stream = probed.streams[0];
    console.log(
      `  container ${probed.format.format_name}, ${stream.codec_name} ` +
        `${stream.sample_rate}Hz ${stream.channels}ch`
    );

    const encodingProblems = [];
    if (stream.codec_name !== "aac") encodingProblems.push(`codec is ${stream.codec_name}, not aac`);
    if (Number(stream.sample_rate) !== 48000)
      encodingProblems.push(`sample rate is ${stream.sample_rate}, not 48000`);
    if (stream.channels !== 2) encodingProblems.push(`${stream.channels} channels, not 2`);
    for (const problem of encodingProblems) console.log(`  FAIL ${problem}`);

    const server = spawn(process.execPath, [path.join(repoRoot, "scripts/playback-check/serve.mjs")], {
      env: { ...process.env, PLAYBACK_ROOT: workDir, PLAYBACK_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      server.stdout.once("data", resolve);
      server.stderr.once("data", (d) => reject(new Error(String(d))));
      setTimeout(() => reject(new Error("server did not start")), 10_000);
    });

    let playbackFailed = false;
    try {
      const url = `http://127.0.0.1:${PORT}/hls/${master}`;
      await new Promise((resolve, reject) => {
        const swift = spawn(
          "swift",
          [path.join(repoRoot, "scripts/playback-check/avplayer-check.swift"), url, duration.toFixed(3)],
          { stdio: "inherit" }
        );
        swift.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        swift.on("error", reject);
      });
    } catch {
      playbackFailed = true;
    } finally {
      server.kill("SIGKILL");
    }

    if (playbackFailed || encodingProblems.length > 0) {
      console.log(`\nFAIL ${audioMediaId}`);
      process.exit(1);
    }
    console.log(`\nPASS ${audioMediaId}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
