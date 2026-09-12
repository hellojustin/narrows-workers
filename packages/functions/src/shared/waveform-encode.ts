/**
 * Encoders and decoders for the two waveform serialisations defined in
 * docs/waveform-format.md: a JSON form for debugging and short episodes, and a
 * binary form for everything else.
 */

import { computeBandEdges } from "./waveform-bands";
import { WAVEFORM_VERSION, type WaveformData } from "./waveform-analyzer";

export const WAVEFORM_MAGIC = "APWF";
export const WAVEFORM_HEADER_BYTES = 64;
export const WAVEFORM_PEAK_BITS = 16;
export const WAVEFORM_BAND_BITS = 8;

export interface WaveformJson {
  version: number;
  sampleRate: number;
  channels: number;
  framesPerSecond: number;
  hopSamples: number;
  fftSize: number;
  bandCount: number;
  bandLowHz: number;
  bandHighHz: number;
  bandEdgesHz: number[];
  bandBits: number;
  peakBits: number;
  dynamicRangeDb: number;
  frameCount: number;
  durationSeconds: number;
  /** Per channel, `frameCount * 2` values: min then max for each frame. */
  peaks: number[][];
  /** Per channel, `frameCount * bandCount` values, frame-major. */
  bands: number[][];
}

export function toWaveformJson(data: WaveformData): WaveformJson {
  return {
    version: data.version,
    sampleRate: data.sampleRate,
    channels: data.channels,
    framesPerSecond: data.framesPerSecond,
    hopSamples: data.hopSamples,
    fftSize: data.fftSize,
    bandCount: data.bandCount,
    bandLowHz: data.bandLowHz,
    bandHighHz: data.bandHighHz,
    bandEdgesHz: data.bandEdgesHz.map((hz) => Math.round(hz * 100) / 100),
    bandBits: WAVEFORM_BAND_BITS,
    peakBits: WAVEFORM_PEAK_BITS,
    dynamicRangeDb: data.dynamicRangeDb,
    frameCount: data.frameCount,
    durationSeconds: Math.round(data.durationSeconds * 1000) / 1000,
    peaks: data.peaks.map((channel) => Array.from(channel)),
    bands: data.bands.map((channel) => Array.from(channel)),
  };
}

export function encodeWaveformJson(data: WaveformData): string {
  return JSON.stringify(toWaveformJson(data));
}

export function parseWaveformJson(text: string): WaveformData {
  const json = JSON.parse(text) as WaveformJson;

  if (json.version !== WAVEFORM_VERSION) {
    throw new Error(`unsupported waveform version ${json.version}`);
  }

  return {
    version: json.version,
    sampleRate: json.sampleRate,
    channels: json.channels,
    framesPerSecond: json.framesPerSecond,
    hopSamples: json.hopSamples,
    fftSize: json.fftSize,
    bandCount: json.bandCount,
    bandEdgesHz: json.bandEdgesHz,
    bandLowHz: json.bandLowHz,
    bandHighHz: json.bandHighHz,
    dynamicRangeDb: json.dynamicRangeDb,
    frameCount: json.frameCount,
    sampleCount: Math.round(json.durationSeconds * json.sampleRate),
    durationSeconds: json.durationSeconds,
    peaks: json.peaks.map((channel) => Int16Array.from(channel)),
    bands: json.bands.map((channel) => Uint8Array.from(channel)),
  };
}

export function encodeWaveformBinary(data: WaveformData): Uint8Array {
  const { channels, bandCount, frameCount } = data;
  const peaksBytes = frameCount * channels * 4;
  const bandsBytes = frameCount * channels * bandCount;
  const peaksOffset = WAVEFORM_HEADER_BYTES;
  const bandsOffset = peaksOffset + peaksBytes;

  const bytes = new Uint8Array(bandsOffset + bandsBytes);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < WAVEFORM_MAGIC.length; i++) bytes[i] = WAVEFORM_MAGIC.charCodeAt(i);
  view.setUint16(4, data.version, true);
  view.setUint16(6, WAVEFORM_HEADER_BYTES, true);
  view.setUint32(8, data.sampleRate, true);
  view.setUint8(12, channels);
  view.setUint8(13, bandCount);
  view.setUint8(14, WAVEFORM_BAND_BITS);
  view.setUint8(15, WAVEFORM_PEAK_BITS);
  view.setUint32(16, data.hopSamples, true);
  view.setUint32(20, data.fftSize, true);
  view.setUint32(24, frameCount, true);
  view.setFloat64(28, data.durationSeconds, true);
  view.setFloat32(36, data.bandLowHz, true);
  view.setFloat32(40, data.bandHighHz, true);
  view.setFloat32(44, data.dynamicRangeDb, true);
  view.setUint32(48, peaksOffset, true);
  view.setUint32(52, peaksBytes, true);
  view.setUint32(56, bandsOffset, true);
  view.setUint32(60, bandsBytes, true);

  // Both sections are frame-major: everything for one frame is contiguous, so a
  // client reads a visible time window as one byte range.
  for (let frame = 0; frame < frameCount; frame++) {
    let at = peaksOffset + frame * channels * 4;
    for (let ch = 0; ch < channels; ch++) {
      view.setInt16(at, data.peaks[ch][frame * 2], true);
      view.setInt16(at + 2, data.peaks[ch][frame * 2 + 1], true);
      at += 4;
    }
  }

  for (let frame = 0; frame < frameCount; frame++) {
    let at = bandsOffset + frame * channels * bandCount;
    for (let ch = 0; ch < channels; ch++) {
      bytes.set(data.bands[ch].subarray(frame * bandCount, (frame + 1) * bandCount), at);
      at += bandCount;
    }
  }

  return bytes;
}

export function decodeWaveformBinary(bytes: Uint8Array): WaveformData {
  if (bytes.length < WAVEFORM_HEADER_BYTES) {
    throw new Error(`waveform binary is too short: ${bytes.length} bytes`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < WAVEFORM_MAGIC.length; i++) {
    if (bytes[i] !== WAVEFORM_MAGIC.charCodeAt(i)) {
      throw new Error("waveform binary has bad magic bytes");
    }
  }

  const version = view.getUint16(4, true);
  if (version !== WAVEFORM_VERSION) {
    throw new Error(`unsupported waveform version ${version}`);
  }

  const sampleRate = view.getUint32(8, true);
  const channels = view.getUint8(12);
  const bandCount = view.getUint8(13);
  const hopSamples = view.getUint32(16, true);
  const fftSize = view.getUint32(20, true);
  const frameCount = view.getUint32(24, true);
  const durationSeconds = view.getFloat64(28, true);
  const bandLowHz = view.getFloat32(36, true);
  const bandHighHz = view.getFloat32(40, true);
  const dynamicRangeDb = view.getFloat32(44, true);
  const peaksOffset = view.getUint32(48, true);
  const peaksBytes = view.getUint32(52, true);
  const bandsOffset = view.getUint32(56, true);
  const bandsBytes = view.getUint32(60, true);

  const needed = Math.max(peaksOffset + peaksBytes, bandsOffset + bandsBytes);
  if (bytes.length < needed) {
    throw new Error(`waveform binary is truncated: ${bytes.length} of ${needed} bytes`);
  }

  const peaks = Array.from({ length: channels }, () => new Int16Array(frameCount * 2));
  const bands = Array.from({ length: channels }, () => new Uint8Array(frameCount * bandCount));

  for (let frame = 0; frame < frameCount; frame++) {
    let at = peaksOffset + frame * channels * 4;
    for (let ch = 0; ch < channels; ch++) {
      peaks[ch][frame * 2] = view.getInt16(at, true);
      peaks[ch][frame * 2 + 1] = view.getInt16(at + 2, true);
      at += 4;
    }
  }

  for (let frame = 0; frame < frameCount; frame++) {
    let at = bandsOffset + frame * channels * bandCount;
    for (let ch = 0; ch < channels; ch++) {
      bands[ch].set(bytes.subarray(at, at + bandCount), frame * bandCount);
      at += bandCount;
    }
  }

  return {
    version,
    sampleRate,
    channels,
    framesPerSecond: sampleRate / hopSamples,
    hopSamples,
    fftSize,
    bandCount,
    bandEdgesHz: computeBandEdges(bandCount, bandLowHz, bandHighHz),
    bandLowHz,
    bandHighHz,
    dynamicRangeDb,
    frameCount,
    sampleCount: Math.round(durationSeconds * sampleRate),
    durationSeconds,
    peaks,
    bands,
  };
}
