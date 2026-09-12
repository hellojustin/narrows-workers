import { describe, it, expect } from "vitest";
import {
  analyzeS16lePcm,
  WaveformAnalyzer,
  type WaveformOptions,
} from "@/shared/waveform-analyzer";
import { computeBandEdges } from "@/shared/waveform-bands";

const SAMPLE_RATE = 48000;

/** Interleaves per-channel int16 sample arrays into s16le PCM bytes. */
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

function silence(count: number): number[] {
  return new Array(count).fill(0);
}

function analyze(pcm: Uint8Array, options: WaveformOptions = {}) {
  const analyzer = new WaveformAnalyzer(options);
  analyzer.push(pcm);
  return analyzer.finish();
}

/** Splits into deterministic pseudo-random chunk sizes, hop-misaligned by design. */
function splitChunks(pcm: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let seed = 12345;
  let offset = 0;
  while (offset < pcm.length) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const size = 1 + (seed % 997);
    chunks.push(pcm.subarray(offset, Math.min(offset + size, pcm.length)));
    offset += size;
  }
  return chunks;
}

function bandContaining(frequency: number, bandCount = 16, low = 40, high = 12000): number {
  const edges = computeBandEdges(bandCount, low, high);
  return edges.findIndex((edge, i) => edge <= frequency && edges[i + 1] > frequency);
}

describe("WaveformAnalyzer frame counts", () => {
  it("emits duration times frames-per-second frames", () => {
    const data = analyze(encodePcm([silence(SAMPLE_RATE * 5), silence(SAMPLE_RATE * 5)]));

    expect(data.frameCount).toBe(100);
    expect(data.durationSeconds).toBeCloseTo(5, 9);
    expect(data.framesPerSecond).toBe(20);
    expect(data.hopSamples).toBe(2400);
    expect(data.peaks[0]).toHaveLength(200);
    expect(data.bands[0]).toHaveLength(1600);
  });

  it("keeps a partial trailing frame", () => {
    const samples = 2400 * 3 + 1200;
    const data = analyze(encodePcm([sine(1000, samples), sine(1000, samples)]));

    expect(data.frameCount).toBe(4);
    expect(data.sampleCount).toBe(samples);
    expect(data.bands[0]).toHaveLength(4 * 16);
  });

  it("returns an empty analysis for empty input", () => {
    const data = analyze(new Uint8Array(0));

    expect(data.frameCount).toBe(0);
    expect(data.durationSeconds).toBe(0);
    expect(data.peaks[0]).toHaveLength(0);
  });

  it("reports the 17 band edges it used", () => {
    const data = analyze(encodePcm([silence(2400), silence(2400)]));

    expect(data.bandEdgesHz).toHaveLength(17);
    expect(data.bandEdgesHz[0]).toBeCloseTo(40, 6);
    expect(data.bandEdgesHz[16]).toBeCloseTo(12000, 6);
  });
});

describe("WaveformAnalyzer peaks", () => {
  it("takes the min and max of each hop-length bucket", () => {
    // 8 Hz sample rate, 4 frames per second: a two-sample bucket.
    const options: WaveformOptions = {
      sampleRate: 8,
      channels: 1,
      framesPerSecond: 4,
      fftSize: 4,
      bandCount: 2,
      bandLowHz: 1,
      bandHighHz: 3,
    };
    const data = analyze(encodePcm([[1000, -2000, 3000, -4000, 5000]]), options);

    expect(data.frameCount).toBe(3);
    expect(Array.from(data.peaks[0])).toEqual([-2000, 1000, -4000, 3000, 5000, 5000]);
  });

  it("keeps channels separate", () => {
    const left = [100, 200, 300, 400];
    const right = [-500, -600, -700, -800];
    const options: WaveformOptions = {
      sampleRate: 8,
      channels: 2,
      framesPerSecond: 4,
      fftSize: 4,
      bandCount: 2,
      bandLowHz: 1,
      bandHighHz: 3,
    };
    const data = analyze(encodePcm([left, right]), options);

    expect(Array.from(data.peaks[0])).toEqual([100, 200, 300, 400]);
    expect(Array.from(data.peaks[1])).toEqual([-600, -500, -800, -700]);
  });

  it("records full-scale samples without clipping the range", () => {
    const data = analyze(encodePcm([[-32768, 32767, 0, 0], [0, 0, 0, 0]]), {
      sampleRate: 8,
      framesPerSecond: 4,
      fftSize: 4,
      bandCount: 2,
      bandLowHz: 1,
      bandHighHz: 3,
    });

    expect(data.peaks[0][0]).toBe(-32768);
    expect(data.peaks[0][1]).toBe(32767);
  });
});

describe("WaveformAnalyzer bands", () => {
  it("concentrates a 1 kHz tone in the band that contains 1 kHz", () => {
    const samples = SAMPLE_RATE * 2;
    const data = analyze(encodePcm([sine(1000, samples), sine(1000, samples)]));
    const band = bandContaining(1000);
    const middle = 20; // A frame past the zero-padded start of the stream.
    const levels = Array.from(data.bands[0].subarray(middle * 16, (middle + 1) * 16));

    expect(levels[band]).toBe(Math.max(...levels));
    expect(levels[band]).toBeGreaterThan(250);
    for (let other = 0; other < 16; other++) {
      if (Math.abs(other - band) <= 1) continue;
      expect(levels[other]).toBeLessThan(levels[band] - 100);
    }
  });

  it("keeps a DC signal out of the high bands", () => {
    const samples = SAMPLE_RATE * 2;
    const data = analyze(encodePcm([new Array(samples).fill(32767), new Array(samples).fill(32767)]));
    const middle = 20;
    const levels = Array.from(data.bands[0].subarray(middle * 16, (middle + 1) * 16));

    // Hann sidelobes put a trace of the DC bin into the two lowest bands,
    // 90 dB or more below full scale. Everything above that reads as silence.
    expect(levels[0]).toBeLessThan(20);
    expect(levels[1]).toBeLessThan(20);
    for (let band = 2; band < 16; band++) {
      expect(levels[band]).toBe(0);
    }
  });

  it("reports silence as level zero", () => {
    const data = analyze(encodePcm([silence(SAMPLE_RATE), silence(SAMPLE_RATE)]));

    expect(Array.from(data.bands[0]).every((level) => level === 0)).toBe(true);
    expect(Array.from(data.bands[1]).every((level) => level === 0)).toBe(true);
  });

  it("tracks a level change between channels", () => {
    const samples = SAMPLE_RATE * 2;
    const loud = sine(1000, samples);
    const quiet = sine(1000, samples, 0.01);
    const data = analyze(encodePcm([loud, quiet]));
    const band = bandContaining(1000);
    const at = 20 * 16 + band;

    expect(data.bands[0][at]).toBeGreaterThan(data.bands[1][at] + 90);
  });
});

describe("WaveformAnalyzer streaming", () => {
  it("produces identical output for one chunk and many arbitrary chunks", () => {
    const samples = 2400 * 7 + 913;
    const pcm = encodePcm([sine(300, samples), sine(2500, samples, 0.6)]);

    const whole = analyze(pcm);
    const streamed = new WaveformAnalyzer();
    for (const chunk of splitChunks(pcm)) streamed.push(chunk);
    const incremental = streamed.finish();

    expect(incremental.frameCount).toBe(whole.frameCount);
    expect(incremental.sampleCount).toBe(whole.sampleCount);
    for (let ch = 0; ch < 2; ch++) {
      expect(Array.from(incremental.peaks[ch])).toEqual(Array.from(whole.peaks[ch]));
      expect(Array.from(incremental.bands[ch])).toEqual(Array.from(whole.bands[ch]));
    }
  });

  it("carries a sample split across a chunk boundary", () => {
    const pcm = encodePcm([sine(1000, 5000), sine(1000, 5000)]);
    const analyzer = new WaveformAnalyzer();
    // Odd byte counts, so every chunk ends mid-sample.
    for (let offset = 0; offset < pcm.length; offset += 3) {
      analyzer.push(pcm.subarray(offset, Math.min(offset + 3, pcm.length)));
    }
    const split = analyzer.finish();
    const whole = analyze(pcm);

    expect(Array.from(split.bands[0])).toEqual(Array.from(whole.bands[0]));
    expect(Array.from(split.peaks[1])).toEqual(Array.from(whole.peaks[1]));
  });

  it("grows its output past the initial capacity", () => {
    const samples = 2400 * 1500;
    const data = analyze(encodePcm([silence(samples), silence(samples)]));

    expect(data.frameCount).toBe(1500);
    expect(data.bands[0]).toHaveLength(1500 * 16);
  });

  it("rejects a push after finish and returns the same result twice", () => {
    const analyzer = new WaveformAnalyzer();
    analyzer.push(encodePcm([silence(2400), silence(2400)]));
    const first = analyzer.finish();

    expect(analyzer.finish()).toBe(first);
    expect(() => analyzer.push(new Uint8Array(4))).toThrow(/after finish/);
  });
});

describe("WaveformAnalyzer channels", () => {
  it("emits one channel for mono input", () => {
    const samples = SAMPLE_RATE;
    const data = analyze(encodePcm([sine(1000, samples)]), { channels: 1 });

    expect(data.channels).toBe(1);
    expect(data.peaks).toHaveLength(1);
    expect(data.bands).toHaveLength(1);
    expect(data.frameCount).toBe(20);
  });

  it("matches mono output on each channel of duplicated stereo", () => {
    const samples = 2400 * 5;
    const mono = sine(440, samples);
    const monoData = analyze(encodePcm([mono]), { channels: 1 });
    const stereoData = analyze(encodePcm([mono, mono]));

    expect(Array.from(stereoData.bands[0])).toEqual(Array.from(monoData.bands[0]));
    expect(Array.from(stereoData.bands[1])).toEqual(Array.from(monoData.bands[0]));
    expect(Array.from(stereoData.peaks[0])).toEqual(Array.from(monoData.peaks[0]));
  });

  it("rejects unsupported channel counts", () => {
    expect(() => new WaveformAnalyzer({ channels: 3 })).toThrow(/channels must be 1 or 2/);
  });
});

describe("analyzeS16lePcm", () => {
  it("consumes an async source of chunks", async () => {
    const pcm = encodePcm([sine(1000, 2400 * 4), sine(1000, 2400 * 4)]);
    async function* source() {
      for (const chunk of splitChunks(pcm)) yield chunk;
    }

    const data = await analyzeS16lePcm(source());

    expect(data.frameCount).toBe(4);
    expect(Array.from(data.bands[0])).toEqual(Array.from(analyze(pcm).bands[0]));
  });
});
