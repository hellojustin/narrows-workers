import { describe, it, expect } from "vitest";
import { WaveformAnalyzer, type WaveformData } from "@/shared/waveform-analyzer";
import { decodeWaveformBinary, encodeWaveformBinary } from "@/shared/waveform-encode";
import {
  buildWaveformOverview,
  WAVEFORM_OVERVIEW_TARGET_FRAMES,
} from "@/shared/waveform-overview";

const SAMPLE_RATE = 48000;
const HOP = 2400;

/**
 * A synthetic analysis with known peaks, so the decimation can be checked
 * against arithmetic rather than against whatever the analyzer produced.
 */
function syntheticWaveform(frameCount: number, channels = 2): WaveformData {
  const peaks = Array.from({ length: channels }, (_, ch) => {
    const data = new Int16Array(frameCount * 2);
    for (let frame = 0; frame < frameCount; frame++) {
      // A repeating ramp rather than a rising one, so a long episode's values
      // stay inside int16 instead of wrapping.
      const amplitude = ((frame % 4_096) + 1) * (ch + 1);
      data[frame * 2] = -amplitude;
      data[frame * 2 + 1] = amplitude;
    }
    return data;
  });

  return {
    version: 1,
    sampleRate: SAMPLE_RATE,
    channels,
    framesPerSecond: SAMPLE_RATE / HOP,
    hopSamples: HOP,
    fftSize: 4096,
    bandCount: 16,
    bandEdgesHz: [40, 12000],
    bandLowHz: 40,
    bandHighHz: 12000,
    dynamicRangeDb: 96,
    frameCount,
    sampleCount: frameCount * HOP,
    durationSeconds: (frameCount * HOP) / SAMPLE_RATE,
    peaks,
    bands: Array.from({ length: channels }, () => new Uint8Array(frameCount * 16)),
  };
}

describe("buildWaveformOverview", () => {
  it("holds the frame count at or below the target however long the episode", () => {
    // 117 minutes, the longest episode in the catalogue, and 4h34m beyond it.
    for (const frameCount of [140_811, 328_800, 2_048, 2_049, 1]) {
      const overview = buildWaveformOverview(syntheticWaveform(frameCount));

      expect(overview.frameCount).toBeLessThanOrEqual(WAVEFORM_OVERVIEW_TARGET_FRAMES);
      expect(overview.frameCount).toBeGreaterThan(0);
    }
  });

  it("stays under 17 KB encoded, which is the point of it existing", () => {
    const overview = buildWaveformOverview(syntheticWaveform(328_800));

    expect(encodeWaveformBinary(overview).byteLength).toBeLessThan(17 * 1024);
  });

  it("takes the extremes of each group, not the mean", () => {
    // 4096 frames over 2048 target is exactly 2 input frames per output frame.
    const source = syntheticWaveform(4_096, 1);
    const overview = buildWaveformOverview(source);

    expect(overview.frameCount).toBe(2_048);
    // Frames 0 and 1 hold mins -1 and -2, maxes 1 and 2.
    expect(overview.peaks[0][0]).toBe(-2);
    expect(overview.peaks[0][1]).toBe(2);
    // Frames 2 and 3 hold mins -3 and -4, maxes 3 and 4.
    expect(overview.peaks[0][2]).toBe(-4);
    expect(overview.peaks[0][3]).toBe(4);
  });

  it("keeps the loudest sample in the episode, so nothing clips off the top", () => {
    const source = syntheticWaveform(100_000, 1);
    // One frame louder than everything around it. Averaging the group would
    // bury it; taking the extremes has to carry it through.
    source.peaks[0][54_321 * 2] = -30_000;
    source.peaks[0][54_321 * 2 + 1] = 30_000;

    const overview = buildWaveformOverview(source);
    const maxes: number[] = [];
    const mins: number[] = [];
    for (let frame = 0; frame < overview.frameCount; frame++) {
      mins.push(overview.peaks[0][frame * 2]);
      maxes.push(overview.peaks[0][frame * 2 + 1]);
    }

    expect(Math.max(...maxes)).toBe(30_000);
    expect(Math.min(...mins)).toBe(-30_000);
  });

  it("makes hopSamples an exact multiple of the source hop", () => {
    const source = syntheticWaveform(140_811);
    const overview = buildWaveformOverview(source);

    expect(overview.hopSamples % source.hopSamples).toBe(0);
    expect(overview.framesPerSecond).toBe(SAMPLE_RATE / overview.hopSamples);
  });

  it("covers the whole episode, so the last frame is not dropped", () => {
    // 140,811 frames over a group of 69 leaves a partial final group.
    const source = syntheticWaveform(140_811, 1);
    const overview = buildWaveformOverview(source);
    const group = overview.hopSamples / source.hopSamples;

    expect(overview.frameCount).toBe(Math.ceil(source.frameCount / group));
    expect(source.frameCount % group).not.toBe(0);

    // The final output frame must summarise the short group at the end rather
    // than reading past it or reporting a zero.
    let expected = source.peaks[0][(overview.frameCount - 1) * group * 2 + 1];
    for (let i = (overview.frameCount - 1) * group; i < source.frameCount; i++) {
      expected = Math.max(expected, source.peaks[0][i * 2 + 1]);
    }
    expect(overview.peaks[0][overview.frameCount * 2 - 1]).toBe(expected);
  });

  it("reports the source duration, not the decimated frame count times the hop", () => {
    const source = syntheticWaveform(140_811);
    const overview = buildWaveformOverview(source);

    expect(overview.durationSeconds).toBe(source.durationSeconds);
    expect(overview.sampleCount).toBe(source.sampleCount);
  });

  it("drops the band section", () => {
    const overview = buildWaveformOverview(syntheticWaveform(10_000));

    expect(overview.bandCount).toBe(0);
    expect(overview.bands[0]).toHaveLength(0);
    expect(overview.bandEdgesHz).toEqual([]);
  });

  it("copies the peaks unchanged when the episode is already short enough", () => {
    const source = syntheticWaveform(500, 1);
    const overview = buildWaveformOverview(source);

    expect(overview.frameCount).toBe(500);
    expect(overview.hopSamples).toBe(source.hopSamples);
    expect(Array.from(overview.peaks[0])).toEqual(Array.from(source.peaks[0]));
  });

  it("handles a mono source without inventing a second channel", () => {
    const overview = buildWaveformOverview(syntheticWaveform(10_000, 1));

    expect(overview.channels).toBe(1);
    expect(overview.peaks).toHaveLength(1);
  });

  it("handles an empty analysis", () => {
    const overview = buildWaveformOverview(new WaveformAnalyzer().finish());

    expect(overview.frameCount).toBe(0);
    expect(overview.peaks[0]).toHaveLength(0);
  });

  it("rejects a target below one frame", () => {
    expect(() => buildWaveformOverview(syntheticWaveform(100), 0)).toThrow(/targetFrames/);
  });
});

describe("the encoded overview", () => {
  /**
   * Clients read the overview with the same reader as waveform.bin, so it has
   * to survive the existing round trip with no band section present.
   */
  it("round-trips through the binary form", () => {
    const overview = buildWaveformOverview(syntheticWaveform(140_811));
    const decoded = decodeWaveformBinary(encodeWaveformBinary(overview));

    expect(decoded.bandCount).toBe(0);
    expect(decoded.channels).toBe(overview.channels);
    expect(decoded.frameCount).toBe(overview.frameCount);
    expect(decoded.hopSamples).toBe(overview.hopSamples);
    expect(decoded.durationSeconds).toBeCloseTo(overview.durationSeconds, 6);
    expect(Array.from(decoded.peaks[0])).toEqual(Array.from(overview.peaks[0]));
    expect(Array.from(decoded.peaks[1])).toEqual(Array.from(overview.peaks[1]));
  });

  it("reports an empty band section in the header", () => {
    const bytes = encodeWaveformBinary(buildWaveformOverview(syntheticWaveform(140_811)));
    const view = new DataView(bytes.buffer);

    expect(view.getUint8(13)).toBe(0);
    expect(view.getUint32(60, true)).toBe(0);
    expect(view.getUint32(52, true)).toBe(bytes.byteLength - 64);
  });
});
