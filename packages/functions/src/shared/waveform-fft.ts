/**
 * Radix-2 FFT and Hann window for the waveform analyzer.
 *
 * Tables (bit reversal, twiddles, window) are built once per size and reused
 * for every frame. A 4h34m episode at 20 frames per second is 328,800 frames
 * per channel, so per-frame allocation is not acceptable.
 */

export class Fft {
  readonly size: number;

  private readonly reversal: Uint32Array;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;

  constructor(size: number) {
    if (size < 4 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two >= 4, got ${size}`);
    }

    this.size = size;
    const bits = Math.log2(size);

    this.reversal = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let reversed = 0;
      for (let bit = 0; bit < bits; bit++) {
        reversed |= ((i >> bit) & 1) << (bits - 1 - bit);
      }
      this.reversal[i] = reversed;
    }

    const half = size / 2;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cosTable[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((-2 * Math.PI * i) / size);
    }
  }

  /**
   * In-place forward transform. Both arrays must be exactly `size` long.
   */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    if (re.length !== n || im.length !== n) {
      throw new Error(`transform() needs arrays of length ${n}`);
    }

    for (let i = 0; i < n; i++) {
      const j = this.reversal[i];
      if (j > i) {
        let swap = re[i];
        re[i] = re[j];
        re[j] = swap;
        swap = im[i];
        im[i] = im[j];
        im[j] = swap;
      }
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let i = start, k = 0; i < start + half; i++, k += step) {
          const cos = this.cosTable[k];
          const sin = this.sinTable[k];
          const oddRe = re[i + half] * cos - im[i + half] * sin;
          const oddIm = re[i + half] * sin + im[i + half] * cos;
          re[i + half] = re[i] - oddRe;
          im[i + half] = im[i] - oddIm;
          re[i] += oddRe;
          im[i] += oddIm;
        }
      }
    }
  }
}

export function hannWindow(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
}

/**
 * Mean of w[n]^2. Band power is divided by this so a windowed signal reports
 * the same level as the unwindowed signal it was cut from (0.375 for Hann).
 */
export function windowPowerGain(window: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < window.length; i++) sum += window[i] * window[i];
  return sum / window.length;
}
