/**
 * Logarithmic band edges, FFT bin assignment, band level in dBFS, and the
 * 8-bit quantisation described in docs/waveform-format.md.
 */

export interface BandBinRange {
  /** First FFT bin in the band, inclusive. */
  lo: number;
  /** Last FFT bin in the band, inclusive. */
  hi: number;
}

/**
 * `bandCount + 1` edge frequencies, geometrically spaced from `lowHz` to
 * `highHz`. Geometric spacing means every band spans the same fraction of an
 * octave: 16 bands from 40 Hz to 12 kHz is log2(300)/16 = 0.51 octaves each.
 */
export function computeBandEdges(bandCount: number, lowHz: number, highHz: number): number[] {
  if (bandCount < 1) throw new Error(`bandCount must be >= 1, got ${bandCount}`);
  if (lowHz <= 0 || highHz <= lowHz) {
    throw new Error(`band range must satisfy 0 < lowHz < highHz, got ${lowHz}..${highHz}`);
  }

  const ratio = highHz / lowHz;
  const edges: number[] = [];
  for (let i = 0; i <= bandCount; i++) {
    edges.push(lowHz * Math.pow(ratio, i / bandCount));
  }
  return edges;
}

/**
 * Maps each band to the FFT bins whose centre frequency falls in the band.
 * DC and Nyquist are excluded. At 4096 points and 48 kHz a bin is 11.7 Hz, so
 * the lowest bands hold one or two bins; that is a limit of the FFT size, not
 * of the band layout.
 */
export function computeBandBins(
  edges: number[],
  sampleRate: number,
  fftSize: number
): BandBinRange[] {
  const binHz = sampleRate / fftSize;
  const maxBin = fftSize / 2 - 1;
  const ranges: BandBinRange[] = [];

  for (let band = 0; band < edges.length - 1; band++) {
    const lo = Math.min(maxBin, Math.max(1, Math.ceil(edges[band] / binHz)));
    const hi = Math.min(maxBin, Math.max(lo, Math.ceil(edges[band + 1] / binHz) - 1));
    ranges.push({ lo, hi });
  }

  return ranges;
}

const MIN_POWER = 1e-30;

/**
 * Band levels in dBFS, written into `out`.
 *
 * Each band sums the power of its bins, then normalises by `4 / (N^2 * g)`
 * where `g` is the window power gain. With that scale a full-scale sine whose
 * frequency lies inside the band reads 0 dBFS, which is the convention audio
 * meters use.
 */
export function bandLevelsDb(
  re: Float64Array,
  im: Float64Array,
  bins: BandBinRange[],
  fftSize: number,
  windowPowerGain: number,
  out: Float64Array
): void {
  const scale = 4 / (fftSize * fftSize * windowPowerGain);

  for (let band = 0; band < bins.length; band++) {
    const { lo, hi } = bins[band];
    let power = 0;
    for (let bin = lo; bin <= hi; bin++) {
      power += re[bin] * re[bin] + im[bin] * im[bin];
    }
    out[band] = 10 * Math.log10(power * scale + MIN_POWER);
  }
}

/**
 * Quantises a dBFS level to 0..255 over `dynamicRangeDb` below full scale.
 * 0 means at or below the bottom of the range, 255 means 0 dBFS.
 */
export function quantiseDb(db: number, dynamicRangeDb: number): number {
  const level = Math.round(((db + dynamicRangeDb) / dynamicRangeDb) * 255);
  return level < 0 ? 0 : level > 255 ? 255 : level;
}

/** Inverse of quantiseDb, for readers and tests. */
export function dequantiseDb(level: number, dynamicRangeDb: number): number {
  return (level / 255) * dynamicRangeDb - dynamicRangeDb;
}
