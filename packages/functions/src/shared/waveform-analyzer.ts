/**
 * Streaming waveform analysis of interleaved signed 16-bit little-endian PCM,
 * the format `ffmpeg -f s16le` writes to stdout.
 *
 * Input is consumed incrementally and never retained: a 4h34m episode decodes
 * to ~3.2 GB of 48 kHz stereo PCM, which does not fit in a Lambda. Only the
 * FFT window (one ring buffer per channel) and the output arrays are held.
 *
 * Output per frame, per channel: the min and max sample in the frame's time
 * bucket, and one quantised level per frequency band. See
 * docs/waveform-format.md for the format these feed.
 */

import {
  bandLevelsDb,
  computeBandBins,
  computeBandEdges,
  quantiseDb,
  type BandBinRange,
} from "./waveform-bands";
import { Fft, hannWindow, windowPowerGain } from "./waveform-fft";

export const WAVEFORM_VERSION = 1;

export const WAVEFORM_DEFAULTS = {
  sampleRate: 48000,
  channels: 2,
  framesPerSecond: 20,
  fftSize: 4096,
  bandCount: 16,
  bandLowHz: 40,
  bandHighHz: 12000,
  dynamicRangeDb: 96,
} as const;

export interface WaveformOptions {
  /** Sample rate of the incoming PCM. Default 48000. */
  sampleRate?: number;
  /** Interleaved channel count, 1 or 2. Mono input produces one channel. */
  channels?: number;
  /** Frames per second. Default 20 (a 2400-sample hop at 48 kHz). */
  framesPerSecond?: number;
  /** FFT size in samples, a power of two. Default 4096. */
  fftSize?: number;
  bandCount?: number;
  bandLowHz?: number;
  bandHighHz?: number;
  /** dB below full scale that quantised level 0 represents. Default 96. */
  dynamicRangeDb?: number;
}

export interface WaveformData {
  version: number;
  sampleRate: number;
  channels: number;
  framesPerSecond: number;
  hopSamples: number;
  fftSize: number;
  bandCount: number;
  bandEdgesHz: number[];
  bandLowHz: number;
  bandHighHz: number;
  dynamicRangeDb: number;
  frameCount: number;
  sampleCount: number;
  durationSeconds: number;
  /** Per channel, `frameCount * 2` int16 values: min then max for each frame. */
  peaks: Int16Array[];
  /** Per channel, `frameCount * bandCount` levels, frame-major. */
  bands: Uint8Array[];
}

const INITIAL_FRAME_CAPACITY = 1200;

export class WaveformAnalyzer {
  readonly sampleRate: number;
  readonly channels: number;
  readonly hopSamples: number;
  readonly fftSize: number;
  readonly bandCount: number;
  readonly bandEdgesHz: number[];
  readonly dynamicRangeDb: number;

  private readonly bandLowHz: number;
  private readonly bandHighHz: number;
  private readonly bins: BandBinRange[];
  private readonly fft: Fft;
  private readonly window: Float64Array;
  private readonly windowGain: number;

  private readonly ring: Float64Array[];
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly levels: Float64Array;

  private ringPos = 0;
  /** Samples written to the ring, including the zero padding added by finish(). */
  private ringWritten = 0;
  /** Samples of real audio consumed. */
  private sampleCount = 0;
  private nextBandEmit: number;
  private bandFrames = 0;
  private peakFrames = 0;
  private bucketFill = 0;
  private readonly bucketMin: Int32Array;
  private readonly bucketMax: Int32Array;

  private frameCapacity = INITIAL_FRAME_CAPACITY;
  private peaks: Int16Array[];
  private bands: Uint8Array[];

  private readonly carry: Uint8Array;
  private carryLength = 0;
  private result: WaveformData | null = null;

  constructor(options: WaveformOptions = {}) {
    const {
      sampleRate = WAVEFORM_DEFAULTS.sampleRate,
      channels = WAVEFORM_DEFAULTS.channels,
      framesPerSecond = WAVEFORM_DEFAULTS.framesPerSecond,
      fftSize = WAVEFORM_DEFAULTS.fftSize,
      bandCount = WAVEFORM_DEFAULTS.bandCount,
      bandLowHz = WAVEFORM_DEFAULTS.bandLowHz,
      bandHighHz = WAVEFORM_DEFAULTS.bandHighHz,
      dynamicRangeDb = WAVEFORM_DEFAULTS.dynamicRangeDb,
    } = options;

    if (channels !== 1 && channels !== 2) {
      throw new Error(`channels must be 1 or 2, got ${channels}`);
    }
    if (sampleRate <= 0) throw new Error(`sampleRate must be positive, got ${sampleRate}`);
    if (framesPerSecond <= 0) {
      throw new Error(`framesPerSecond must be positive, got ${framesPerSecond}`);
    }

    const hopSamples = Math.round(sampleRate / framesPerSecond);
    if (hopSamples < 1) {
      throw new Error(`framesPerSecond ${framesPerSecond} is too high for ${sampleRate} Hz`);
    }

    this.sampleRate = sampleRate;
    this.channels = channels;
    this.hopSamples = hopSamples;
    this.fftSize = fftSize;
    this.bandCount = bandCount;
    this.bandLowHz = bandLowHz;
    this.bandHighHz = bandHighHz;
    this.dynamicRangeDb = dynamicRangeDb;

    this.bandEdgesHz = computeBandEdges(bandCount, bandLowHz, bandHighHz);
    this.bins = computeBandBins(this.bandEdgesHz, sampleRate, fftSize);
    this.fft = new Fft(fftSize);
    this.window = hannWindow(fftSize);
    this.windowGain = windowPowerGain(this.window);

    this.ring = Array.from({ length: channels }, () => new Float64Array(fftSize));
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
    this.levels = new Float64Array(bandCount);

    // Frame f's band window is centred on its time bucket, so it can be
    // emitted once the ring holds every sample up to bucket centre + fftSize/2.
    this.nextBandEmit = Math.floor(hopSamples / 2) + fftSize / 2;

    this.bucketMin = new Int32Array(channels);
    this.bucketMax = new Int32Array(channels);
    this.resetBucket();

    this.peaks = Array.from({ length: channels }, () => new Int16Array(this.frameCapacity * 2));
    this.bands = Array.from(
      { length: channels },
      () => new Uint8Array(this.frameCapacity * bandCount)
    );

    this.carry = new Uint8Array(2 * channels);
  }

  /**
   * Consumes a chunk of interleaved s16le PCM. Chunk boundaries are arbitrary:
   * a partial sample block is carried over to the next call.
   */
  push(chunk: Uint8Array): void {
    if (this.result) throw new Error("push() called after finish()");

    const blockBytes = 2 * this.channels;
    let offset = 0;

    if (this.carryLength > 0) {
      const take = Math.min(blockBytes - this.carryLength, chunk.length);
      this.carry.set(chunk.subarray(0, take), this.carryLength);
      this.carryLength += take;
      offset = take;
      if (this.carryLength < blockBytes) return;
      this.writeBlock(this.carry, 0);
      this.carryLength = 0;
    }

    const end = chunk.length - ((chunk.length - offset) % blockBytes);
    for (; offset < end; offset += blockBytes) this.writeBlock(chunk, offset);

    if (offset < chunk.length) {
      this.carry.set(chunk.subarray(offset));
      this.carryLength = chunk.length - offset;
    }
  }

  /**
   * Flushes the trailing partial bucket and the band frames still inside the
   * FFT window, then returns the analysis. Idempotent; further pushes throw.
   */
  finish(): WaveformData {
    if (this.result) return this.result;

    if (this.bucketFill > 0) this.flushPeakFrame();

    const frameCount = Math.ceil(this.sampleCount / this.hopSamples);
    while (this.bandFrames < frameCount) {
      for (let ch = 0; ch < this.channels; ch++) this.ring[ch][this.ringPos] = 0;
      this.ringPos = (this.ringPos + 1) % this.fftSize;
      this.ringWritten++;
      if (this.ringWritten === this.nextBandEmit) this.emitBandFrame();
    }

    this.result = {
      version: WAVEFORM_VERSION,
      sampleRate: this.sampleRate,
      channels: this.channels,
      framesPerSecond: this.sampleRate / this.hopSamples,
      hopSamples: this.hopSamples,
      fftSize: this.fftSize,
      bandCount: this.bandCount,
      bandEdgesHz: this.bandEdgesHz,
      bandLowHz: this.bandLowHz,
      bandHighHz: this.bandHighHz,
      dynamicRangeDb: this.dynamicRangeDb,
      frameCount,
      sampleCount: this.sampleCount,
      durationSeconds: this.sampleCount / this.sampleRate,
      peaks: this.peaks.map((data) => data.subarray(0, frameCount * 2)),
      bands: this.bands.map((data) => data.subarray(0, frameCount * this.bandCount)),
    };

    return this.result;
  }

  private writeBlock(buffer: Uint8Array, offset: number): void {
    for (let ch = 0; ch < this.channels; ch++) {
      const at = offset + ch * 2;
      // Signed 16-bit little-endian, sign-extended.
      const sample = (((buffer[at] | (buffer[at + 1] << 8)) << 16) >> 16);
      if (sample < this.bucketMin[ch]) this.bucketMin[ch] = sample;
      if (sample > this.bucketMax[ch]) this.bucketMax[ch] = sample;
      this.ring[ch][this.ringPos] = sample / 32768;
    }

    this.ringPos = (this.ringPos + 1) % this.fftSize;
    this.ringWritten++;
    this.sampleCount++;

    if (++this.bucketFill === this.hopSamples) this.flushPeakFrame();
    if (this.ringWritten === this.nextBandEmit) this.emitBandFrame();
  }

  private flushPeakFrame(): void {
    this.ensureCapacity(Math.max(this.peakFrames, this.bandFrames) + 1);
    const at = this.peakFrames * 2;
    for (let ch = 0; ch < this.channels; ch++) {
      this.peaks[ch][at] = this.bucketMin[ch];
      this.peaks[ch][at + 1] = this.bucketMax[ch];
    }
    this.peakFrames++;
    this.bucketFill = 0;
    this.resetBucket();
  }

  private emitBandFrame(): void {
    this.ensureCapacity(Math.max(this.peakFrames, this.bandFrames) + 1);
    const at = this.bandFrames * this.bandCount;

    for (let ch = 0; ch < this.channels; ch++) {
      const ring = this.ring[ch];
      // The oldest sample in the ring is at ringPos, so the window starts there.
      for (let i = 0; i < this.fftSize; i++) {
        const pos = this.ringPos + i;
        this.re[i] = ring[pos < this.fftSize ? pos : pos - this.fftSize] * this.window[i];
        this.im[i] = 0;
      }

      this.fft.transform(this.re, this.im);
      bandLevelsDb(this.re, this.im, this.bins, this.fftSize, this.windowGain, this.levels);

      const out = this.bands[ch];
      for (let band = 0; band < this.bandCount; band++) {
        out[at + band] = quantiseDb(this.levels[band], this.dynamicRangeDb);
      }
    }

    this.bandFrames++;
    this.nextBandEmit += this.hopSamples;
  }

  private resetBucket(): void {
    for (let ch = 0; ch < this.channels; ch++) {
      this.bucketMin[ch] = 32767;
      this.bucketMax[ch] = -32768;
    }
  }

  private ensureCapacity(frames: number): void {
    if (frames <= this.frameCapacity) return;

    let capacity = this.frameCapacity;
    while (capacity < frames) capacity *= 2;

    this.peaks = this.peaks.map((data) => {
      const grown = new Int16Array(capacity * 2);
      grown.set(data);
      return grown;
    });
    this.bands = this.bands.map((data) => {
      const grown = new Uint8Array(capacity * this.bandCount);
      grown.set(data);
      return grown;
    });
    this.frameCapacity = capacity;
  }
}

/**
 * Runs the analyzer over an async source of s16le PCM chunks, such as the
 * stdout of an ffmpeg child process or an S3 object body.
 */
export async function analyzeS16lePcm(
  source: AsyncIterable<Uint8Array>,
  options: WaveformOptions = {}
): Promise<WaveformData> {
  const analyzer = new WaveformAnalyzer(options);
  for await (const chunk of source) analyzer.push(chunk);
  return analyzer.finish();
}
