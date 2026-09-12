import { describe, it, expect } from "vitest";
import {
  bandLevelsDb,
  computeBandBins,
  computeBandEdges,
  dequantiseDb,
  quantiseDb,
} from "@/shared/waveform-bands";
import { Fft, hannWindow, windowPowerGain } from "@/shared/waveform-fft";

const SAMPLE_RATE = 48000;
const FFT_SIZE = 4096;

/** dBFS per band for a full-scale sine at `frequency`. */
function analyseSine(frequency: number): number[] {
  const window = hannWindow(FFT_SIZE);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    re[i] = Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE) * window[i];
  }

  new Fft(FFT_SIZE).transform(re, im);

  const edges = computeBandEdges(16, 40, 12000);
  const bins = computeBandBins(edges, SAMPLE_RATE, FFT_SIZE);
  const levels = new Float64Array(16);
  bandLevelsDb(re, im, bins, FFT_SIZE, windowPowerGain(window), levels);
  return Array.from(levels);
}

describe("computeBandEdges", () => {
  it("returns bandCount + 1 edges spanning the requested range", () => {
    const edges = computeBandEdges(16, 40, 12000);
    expect(edges).toHaveLength(17);
    expect(edges[0]).toBeCloseTo(40, 6);
    expect(edges[16]).toBeCloseTo(12000, 6);
  });

  it("spaces edges geometrically", () => {
    const edges = computeBandEdges(16, 40, 12000);
    const ratio = edges[1] / edges[0];
    expect(ratio).toBeCloseTo(Math.pow(300, 1 / 16), 9);
    for (let band = 1; band < 16; band++) {
      expect(edges[band + 1] / edges[band]).toBeCloseTo(ratio, 9);
    }
  });

  it("rejects invalid ranges", () => {
    expect(() => computeBandEdges(0, 40, 12000)).toThrow(/bandCount/);
    expect(() => computeBandEdges(16, 0, 12000)).toThrow(/lowHz/);
    expect(() => computeBandEdges(16, 12000, 40)).toThrow(/lowHz/);
  });
});

describe("computeBandBins", () => {
  const bins = computeBandBins(computeBandEdges(16, 40, 12000), SAMPLE_RATE, FFT_SIZE);

  it("assigns every band at least one bin, excluding DC", () => {
    expect(bins).toHaveLength(16);
    for (const { lo, hi } of bins) {
      expect(lo).toBeGreaterThanOrEqual(1);
      expect(hi).toBeGreaterThanOrEqual(lo);
      expect(hi).toBeLessThanOrEqual(FFT_SIZE / 2 - 1);
    }
  });

  it("produces contiguous, non-overlapping ranges", () => {
    for (let band = 1; band < bins.length; band++) {
      expect(bins[band].lo).toBe(bins[band - 1].hi + 1);
    }
  });

  it("clamps a high edge above Nyquist", () => {
    const clamped = computeBandBins(computeBandEdges(4, 100, 40000), SAMPLE_RATE, FFT_SIZE);
    expect(clamped[3].hi).toBe(FFT_SIZE / 2 - 1);
  });
});

describe("bandLevelsDb", () => {
  it("reads a full-scale sine as 0 dBFS in its own band", () => {
    const levels = analyseSine(1000);
    const edges = computeBandEdges(16, 40, 12000);
    const band = edges.findIndex((edge, i) => edge <= 1000 && edges[i + 1] > 1000);

    expect(band).toBeGreaterThanOrEqual(0);
    // The window spreads a little energy into the neighbouring bands, so the
    // reading sits just under 0 dBFS rather than exactly on it.
    expect(levels[band]).toBeGreaterThan(-0.5);
    expect(levels[band]).toBeLessThan(0.1);
    expect(Math.max(...levels)).toBeCloseTo(levels[band], 6);
  });

  it("keeps energy out of distant bands", () => {
    const levels = analyseSine(1000);
    expect(levels[0]).toBeLessThan(-80);
    expect(levels[15]).toBeLessThan(-80);
  });
});

describe("quantiseDb", () => {
  it("maps full scale to 255 and the bottom of the range to 0", () => {
    expect(quantiseDb(0, 96)).toBe(255);
    expect(quantiseDb(-96, 96)).toBe(0);
    expect(quantiseDb(-48, 96)).toBe(128);
  });

  it("clamps outside the range", () => {
    expect(quantiseDb(12, 96)).toBe(255);
    expect(quantiseDb(-300, 96)).toBe(0);
  });

  it("round-trips within half a quantisation step", () => {
    const step = 96 / 255;
    for (const db of [-95, -70.4, -30, -12.7, -0.5]) {
      expect(Math.abs(dequantiseDb(quantiseDb(db, 96), 96) - db)).toBeLessThanOrEqual(step / 2);
    }
  });
});
