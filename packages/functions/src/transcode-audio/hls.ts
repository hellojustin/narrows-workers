/**
 * HLS transcode with ffmpeg.
 *
 * Output properties are fixed by docs/hls-output-spec.md: AAC-LC at 128 kbps,
 * 48 kHz, stereo, in 10-second segments. Byte-identical output to MediaConvert is
 * not a requirement, so ffmpeg's own `hls` muxer is used rather than hand-built
 * segments and playlists.
 */

import { readdir, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { runFfmpeg, type FfmpegOptions } from "../shared/ffmpeg";

/** Encoding settings. These are the requirement; do not change without updating the spec. */
export const AUDIO_CODEC = "aac";
export const AUDIO_BITRATE = "128k";
export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_CHANNELS = 2;
export const SEGMENT_SECONDS = 10;

/**
 * MPEG-TS, produced by ffmpeg's `hls` muxer.
 *
 * The existing catalogue is raw ADTS in `.aac` files because that is what
 * MediaConvert produced. MPEG-TS is 7.0% larger, but it carries presentation
 * timestamps in the transport layer, so it needs no per-segment ID3 tag. Raw ADTS
 * would require generating the mandatory `com.apple.streaming.transportStreamTimestamp`
 * ID3 frame and both playlists by hand.
 *
 * Each playlist is self-describing, so a catalogue holding both forms is fine.
 */
export const SEGMENT_EXTENSION = "ts";

export interface TranscodeOutput {
  /** Local directory holding the playlists and segments. */
  outputDir: string;
  masterPlaylistName: string;
  audioPlaylistName: string;
  segmentNames: string[];
}

/**
 * Filenames are fixed by code elsewhere in the pipeline, not by preference:
 * the fan-in HeadObjects `{mediaId}.m3u8` as its signal that HLS is ready, and
 * generate-hls-subtitles reads `{mediaId}_audio.m3u8` to derive subtitle
 * boundaries. See generate-hls-subtitles/paths.ts.
 */
export function masterPlaylistName(audioMediaId: string): string {
  return `${audioMediaId}.m3u8`;
}

export function audioPlaylistName(audioMediaId: string): string {
  return `${audioMediaId}_audio.m3u8`;
}

export function segmentPattern(audioMediaId: string): string {
  return `${audioMediaId}_audio_%05d.${SEGMENT_EXTENSION}`;
}

export function buildHlsArgs(params: {
  input: string;
  outputDir: string;
  audioMediaId: string;
}): string[] {
  const { input, outputDir, audioMediaId } = params;

  return [
    "-i",
    input,
    // Explicitly the first audio stream. Many podcast mp3s carry embedded cover
    // art as a video stream, which ffmpeg would otherwise try to carry through.
    "-map",
    "0:a:0",
    "-c:a",
    AUDIO_CODEC,
    "-b:a",
    AUDIO_BITRATE,
    "-ar",
    String(AUDIO_SAMPLE_RATE),
    "-ac",
    String(AUDIO_CHANNELS),
    "-f",
    "hls",
    "-hls_time",
    String(SEGMENT_SECONDS),
    "-hls_playlist_type",
    "vod",
    // 0 keeps every segment in the playlist. The default of 5 would produce a
    // playlist listing only the last five segments of a VOD stream.
    "-hls_list_size",
    "0",
    "-master_pl_name",
    masterPlaylistName(audioMediaId),
    "-hls_segment_filename",
    path.join(outputDir, segmentPattern(audioMediaId)),
    path.join(outputDir, audioPlaylistName(audioMediaId)),
  ];
}

/**
 * Transcode to a local directory. Uploading is the caller's job, because write
 * ordering matters: the master playlist must be uploaded last.
 */
export async function transcodeToHls(params: {
  input: string;
  outputDir: string;
  audioMediaId: string;
  ffmpegOptions?: FfmpegOptions;
}): Promise<TranscodeOutput> {
  const { input, outputDir, audioMediaId } = params;

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await runFfmpeg(buildHlsArgs({ input, outputDir, audioMediaId }), {
    label: `transcode ${audioMediaId}`,
    ...params.ffmpegOptions,
  });

  const entries = await readdir(outputDir);
  const suffix = `.${SEGMENT_EXTENSION}`;
  const segmentNames = entries.filter((name) => name.endsWith(suffix)).sort();

  if (segmentNames.length === 0) {
    throw new Error(`Transcode of ${audioMediaId} produced no segments`);
  }

  const master = masterPlaylistName(audioMediaId);
  const audio = audioPlaylistName(audioMediaId);
  for (const required of [master, audio]) {
    if (!entries.includes(required)) {
      throw new Error(`Transcode of ${audioMediaId} did not produce ${required}`);
    }
  }

  return {
    outputDir,
    masterPlaylistName: master,
    audioPlaylistName: audio,
    segmentNames,
  };
}

export interface PlaylistCheck {
  segmentCount: number;
  totalDurationSec: number;
}

/**
 * Confirm the playlist describes exactly the segments on disk.
 *
 * This catches the failure mode seen while testing parallel time-range chunking,
 * where two chunks claimed the same segment number: the playlists listed 931
 * entries while only 928 files existed, and playback silently skipped audio.
 */
export function verifyPlaylistAgainstSegments(
  playlistContent: string,
  segmentNames: string[]
): PlaylistCheck {
  const referenced: string[] = [];
  let totalDurationSec = 0;

  const lines = playlistContent.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = /^#EXTINF:([\d.]+)/.exec(line);
    if (!match) continue;
    totalDurationSec += Number.parseFloat(match[1]);
    // The URI is the next non-comment, non-empty line.
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate || candidate.startsWith("#")) continue;
      referenced.push(path.basename(candidate));
      break;
    }
  }

  const onDisk = new Set(segmentNames);
  const missing = referenced.filter((name) => !onDisk.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Playlist references ${missing.length} segment(s) not on disk: ${missing.slice(0, 5).join(", ")}`
    );
  }

  const duplicates = referenced.filter((name, index) => referenced.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Playlist references duplicate segments: ${duplicates.slice(0, 5).join(", ")}`);
  }

  const unreferenced = segmentNames.filter((name) => !referenced.includes(name));
  if (unreferenced.length > 0) {
    throw new Error(
      `${unreferenced.length} segment(s) on disk are not in the playlist: ${unreferenced
        .slice(0, 5)
        .join(", ")}`
    );
  }

  return { segmentCount: referenced.length, totalDurationSec };
}
