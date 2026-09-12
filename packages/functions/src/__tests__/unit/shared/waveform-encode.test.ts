import { describe, it, expect } from "vitest";
import { WaveformAnalyzer, type WaveformData } from "@/shared/waveform-analyzer";
import {
  decodeWaveformBinary,
  encodeWaveformBinary,
  encodeWaveformJson,
  parseWaveformJson,
  WAVEFORM_HEADER_BYTES,
} from "@/shared/waveform-encode";

const SAMPLE_RATE = 48000;

function encodePcm(channels: number[][]): Uint8Array {
  const frames = channels[0].length;
  const bytes = new Uint8Array(frames * channels.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels.length; ch++) {
      view.setInt16((i * channels.length + ch) * 2, channels[ch][i], true);
    }
  }
  return bytes;
}

function sine(frequency: number, count: number, amplitude = 1): number[] {
  return Array.from({ length: count }, (_, i) =>
    Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE))
  );
}

function sampleWaveform(channelCount = 2): WaveformData {
  const samples = 2400 * 6 + 700;
  const left = sine(700, samples);
  const right = sine(3000, samples, 0.4);
  const analyzer = new WaveformAnalyzer({ channels: channelCount });
  analyzer.push(encodePcm(channelCount === 1 ? [left] : [left, right]));
  return analyzer.finish();
}

function expectSameAnalysis(actual: WaveformData, expected: WaveformData): void {
  expect(actual.version).toBe(expected.version);
  expect(actual.sampleRate).toBe(expected.sampleRate);
  expect(actual.channels).toBe(expected.channels);
  expect(actual.framesPerSecond).toBe(expected.framesPerSecond);
  expect(actual.hopSamples).toBe(expected.hopSamples);
  expect(actual.fftSize).toBe(expected.fftSize);
  expect(actual.bandCount).toBe(expected.bandCount);
  expect(actual.frameCount).toBe(expected.frameCount);
  expect(actual.dynamicRangeDb).toBe(expected.dynamicRangeDb);
  expect(actual.durationSeconds).toBeCloseTo(expected.durationSeconds, 3);
  expect(actual.bandEdgesHz[0]).toBeCloseTo(expected.bandEdgesHz[0], 2);
  expect(actual.bandEdgesHz[16]).toBeCloseTo(expected.bandEdgesHz[16], 2);
  for (let ch = 0; ch < expected.channels; ch++) {
    expect(Array.from(actual.peaks[ch])).toEqual(Array.from(expected.peaks[ch]));
    expect(Array.from(actual.bands[ch])).toEqual(Array.from(expected.bands[ch]));
  }
}

describe("encodeWaveformBinary", () => {
  it("writes the header, then the peak section, then the band section", () => {
    const data = sampleWaveform();
    const bytes = encodeWaveformBinary(data);
    const view = new DataView(bytes.buffer);

    const peaksBytes = data.frameCount * data.channels * 4;
    const bandsBytes = data.frameCount * data.channels * data.bandCount;
    expect(bytes).toHaveLength(WAVEFORM_HEADER_BYTES + peaksBytes + bandsBytes);

    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("APWF");
    expect(view.getUint16(4, true)).toBe(1);
    expect(view.getUint16(6, true)).toBe(WAVEFORM_HEADER_BYTES);
    expect(view.getUint32(8, true)).toBe(48000);
    expect(view.getUint8(12)).toBe(2);
    expect(view.getUint8(13)).toBe(16);
    expect(view.getUint8(14)).toBe(8);
    expect(view.getUint8(15)).toBe(16);
    expect(view.getUint32(16, true)).toBe(2400);
    expect(view.getUint32(20, true)).toBe(4096);
    expect(view.getUint32(24, true)).toBe(data.frameCount);
    expect(view.getFloat64(28, true)).toBeCloseTo(data.durationSeconds, 9);
    expect(view.getFloat32(36, true)).toBeCloseTo(40, 3);
    expect(view.getFloat32(40, true)).toBeCloseTo(12000, 3);
    expect(view.getFloat32(44, true)).toBeCloseTo(96, 3);
    expect(view.getUint32(48, true)).toBe(WAVEFORM_HEADER_BYTES);
    expect(view.getUint32(52, true)).toBe(peaksBytes);
    expect(view.getUint32(56, true)).toBe(WAVEFORM_HEADER_BYTES + peaksBytes);
    expect(view.getUint32(60, true)).toBe(bandsBytes);
  });

  it("orders both sections frame-major", () => {
    const data = sampleWaveform();
    const bytes = encodeWaveformBinary(data);
    const view = new DataView(bytes.buffer);
    const peaksOffset = view.getUint32(48, true);
    const bandsOffset = view.getUint32(56, true);
    const frame = 3;

    expect(view.getInt16(peaksOffset + frame * 8, true)).toBe(data.peaks[0][frame * 2]);
    expect(view.getInt16(peaksOffset + frame * 8 + 2, true)).toBe(data.peaks[0][frame * 2 + 1]);
    expect(view.getInt16(peaksOffset + frame * 8 + 4, true)).toBe(data.peaks[1][frame * 2]);
    expect(view.getInt16(peaksOffset + frame * 8 + 6, true)).toBe(data.peaks[1][frame * 2 + 1]);

    const frameStart = bandsOffset + frame * 2 * 16;
    expect(Array.from(bytes.subarray(frameStart, frameStart + 16))).toEqual(
      Array.from(data.bands[0].subarray(frame * 16, (frame + 1) * 16))
    );
    expect(Array.from(bytes.subarray(frameStart + 16, frameStart + 32))).toEqual(
      Array.from(data.bands[1].subarray(frame * 16, (frame + 1) * 16))
    );
  });
});

describe("decodeWaveformBinary", () => {
  it("round-trips a stereo analysis", () => {
    const data = sampleWaveform();
    expectSameAnalysis(decodeWaveformBinary(encodeWaveformBinary(data)), data);
  });

  it("round-trips a mono analysis", () => {
    const data = sampleWaveform(1);
    const decoded = decodeWaveformBinary(encodeWaveformBinary(data));

    expect(decoded.channels).toBe(1);
    expectSameAnalysis(decoded, data);
  });

  it("round-trips an empty analysis", () => {
    const empty = new WaveformAnalyzer().finish();
    const decoded = decodeWaveformBinary(encodeWaveformBinary(empty));

    expect(decoded.frameCount).toBe(0);
    expect(decoded.peaks[0]).toHaveLength(0);
  });

  it("survives a non-zero byte offset in the backing buffer", () => {
    const data = sampleWaveform();
    const bytes = encodeWaveformBinary(data);
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 8);

    expectSameAnalysis(decodeWaveformBinary(padded.subarray(8)), data);
  });

  it("rejects bad magic bytes", () => {
    const bytes = encodeWaveformBinary(sampleWaveform());
    bytes[1] = 0;

    expect(() => decodeWaveformBinary(bytes)).toThrow(/magic/);
  });

  it("rejects an unknown version", () => {
    const bytes = encodeWaveformBinary(sampleWaveform());
    new DataView(bytes.buffer).setUint16(4, 99, true);

    expect(() => decodeWaveformBinary(bytes)).toThrow(/unsupported waveform version 99/);
  });

  it("rejects a truncated header", () => {
    expect(() => decodeWaveformBinary(new Uint8Array(12))).toThrow(/too short/);
  });

  it("rejects a body shorter than the header claims", () => {
    const bytes = encodeWaveformBinary(sampleWaveform());

    expect(() => decodeWaveformBinary(bytes.subarray(0, bytes.length - 40))).toThrow(/truncated/);
  });
});

describe("encodeWaveformJson", () => {
  it("round-trips an analysis", () => {
    const data = sampleWaveform();
    expectSameAnalysis(parseWaveformJson(encodeWaveformJson(data)), data);
  });

  it("emits per-channel flat arrays", () => {
    const data = sampleWaveform();
    const json = JSON.parse(encodeWaveformJson(data));

    expect(json.version).toBe(1);
    expect(json.bandBits).toBe(8);
    expect(json.peakBits).toBe(16);
    expect(json.bandEdgesHz).toHaveLength(17);
    expect(json.peaks).toHaveLength(2);
    expect(json.peaks[0]).toHaveLength(data.frameCount * 2);
    expect(json.bands[0]).toHaveLength(data.frameCount * 16);
  });

  it("rejects an unknown version", () => {
    const json = JSON.parse(encodeWaveformJson(sampleWaveform()));
    json.version = 42;

    expect(() => parseWaveformJson(JSON.stringify(json))).toThrow(/unsupported waveform version 42/);
  });
});
