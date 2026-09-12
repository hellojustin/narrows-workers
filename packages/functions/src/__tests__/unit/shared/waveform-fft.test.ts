import { describe, it, expect } from "vitest";
import { Fft, hannWindow, windowPowerGain } from "@/shared/waveform-fft";

function magnitudes(re: Float64Array, im: Float64Array): number[] {
  return Array.from(re, (real, i) => Math.hypot(real, im[i]));
}

describe("Fft", () => {
  it("rejects sizes that are not a power of two", () => {
    expect(() => new Fft(1000)).toThrow(/power of two/);
    expect(() => new Fft(2)).toThrow(/power of two/);
  });

  it("puts a DC signal entirely in bin 0", () => {
    const fft = new Fft(16);
    const re = new Float64Array(16).fill(0.5);
    const im = new Float64Array(16);

    fft.transform(re, im);

    const mags = magnitudes(re, im);
    expect(mags[0]).toBeCloseTo(8, 6);
    for (let bin = 1; bin < 16; bin++) {
      expect(mags[bin]).toBeLessThan(1e-9);
    }
  });

  it("puts a bin-centred sine in that bin only", () => {
    const size = 64;
    const bin = 7;
    const fft = new Fft(size);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = Math.sin((2 * Math.PI * bin * i) / size);

    fft.transform(re, im);

    const mags = magnitudes(re, im);
    expect(mags[bin]).toBeCloseTo(size / 2, 6);
    expect(mags[size - bin]).toBeCloseTo(size / 2, 6);
    for (let k = 0; k < size; k++) {
      if (k === bin || k === size - bin) continue;
      expect(mags[k]).toBeLessThan(1e-9);
    }
  });

  it("matches a direct discrete Fourier transform", () => {
    const size = 32;
    const input = Array.from({ length: size }, (_, i) => Math.sin(i) + 0.3 * Math.cos(3 * i));

    const re = Float64Array.from(input);
    const im = new Float64Array(size);
    new Fft(size).transform(re, im);

    for (let k = 0; k < size; k++) {
      let expectedRe = 0;
      let expectedIm = 0;
      for (let n = 0; n < size; n++) {
        const angle = (-2 * Math.PI * k * n) / size;
        expectedRe += input[n] * Math.cos(angle);
        expectedIm += input[n] * Math.sin(angle);
      }
      expect(re[k]).toBeCloseTo(expectedRe, 8);
      expect(im[k]).toBeCloseTo(expectedIm, 8);
    }
  });

  it("rejects arrays of the wrong length", () => {
    const fft = new Fft(8);
    expect(() => fft.transform(new Float64Array(8), new Float64Array(4))).toThrow(/length 8/);
  });
});

describe("hannWindow", () => {
  it("starts and ends at zero and peaks at the centre", () => {
    const window = hannWindow(1024);
    expect(window[0]).toBeCloseTo(0, 12);
    expect(window[1023]).toBeCloseTo(0, 12);
    expect(Math.max(...window)).toBeCloseTo(1, 5);
  });

  it("has a power gain of 0.375", () => {
    expect(windowPowerGain(hannWindow(4096))).toBeCloseTo(0.375, 3);
  });
});
