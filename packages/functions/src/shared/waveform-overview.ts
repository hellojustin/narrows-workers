/**
 * Decimation of a full-resolution analysis down to a fixed-size overview, the
 * `waveform-overview.bin` form in docs/waveform-format.md.
 *
 * Range requests into `waveform.bin` serve any zoomed view in a few kilobytes,
 * because the sections are frame-major. They do not serve a scrubber showing a
 * whole episode at once, which needs every frame and so the entire peak
 * section: 1.07 MB for a 117-minute episode, to draw about a thousand pixels.
 * The overview is that view precomputed.
 */

import { type WaveformData } from "./waveform-analyzer";

/**
 * Frames in an overview, whatever the episode length.
 *
 * A scrubber is a fixed number of pixels wide regardless of duration, so the
 * useful size of an overview is fixed too. 2048 frames gives a 1000-pixel
 * scrubber two frames per pixel, and holds the object at 16 KB.
 */
export const WAVEFORM_OVERVIEW_TARGET_FRAMES = 2048;

/**
 * Collapse `data` to at most `targetFrames` frames of peaks.
 *
 * Each output frame covers a whole number of input frames, so `hopSamples` is
 * an exact multiple of the source's and an output frame maps onto a known span
 * of `waveform.bin`. A client that draws the overview and then zooms can
 * convert between the two grids without a rounding rule.
 *
 * The peaks are combined by taking the extremes of the group rather than the
 * mean. A mean shrinks every transient towards zero, which at 69:1 would leave
 * a two-hour episode looking like a flat band; the extremes keep the envelope
 * the same shape at every zoom level.
 *
 * Band levels are dropped. The result carries `bandCount: 0` and no band
 * section. Spectral colour over a whole episode is four fifths of the file and
 * is not what a scrubber draws, so it stays in `waveform.bin` where a client
 * can range-request the window it is actually showing.
 */
export function buildWaveformOverview(
  data: WaveformData,
  targetFrames: number = WAVEFORM_OVERVIEW_TARGET_FRAMES
): WaveformData {
  if (targetFrames < 1) {
    throw new Error(`targetFrames must be >= 1, got ${targetFrames}`);
  }

  const { channels, frameCount } = data;
  const group = Math.max(1, Math.ceil(frameCount / targetFrames));
  const overviewFrames = Math.ceil(frameCount / group);

  const peaks = Array.from({ length: channels }, () => new Int16Array(overviewFrames * 2));

  for (let ch = 0; ch < channels; ch++) {
    const source = data.peaks[ch];
    const out = peaks[ch];

    for (let frame = 0; frame < overviewFrames; frame++) {
      const from = frame * group;
      const to = Math.min(frameCount, from + group);

      let min = source[from * 2];
      let max = source[from * 2 + 1];
      for (let i = from + 1; i < to; i++) {
        if (source[i * 2] < min) min = source[i * 2];
        if (source[i * 2 + 1] > max) max = source[i * 2 + 1];
      }

      out[frame * 2] = min;
      out[frame * 2 + 1] = max;
    }
  }

  const hopSamples = data.hopSamples * group;

  return {
    version: data.version,
    sampleRate: data.sampleRate,
    channels,
    framesPerSecond: data.sampleRate / hopSamples,
    hopSamples,
    // Inherited from the source analysis so the overview still describes where
    // it came from. No band data is present to apply them to.
    fftSize: data.fftSize,
    bandCount: 0,
    bandEdgesHz: [],
    bandLowHz: data.bandLowHz,
    bandHighHz: data.bandHighHz,
    dynamicRangeDb: data.dynamicRangeDb,
    frameCount: overviewFrames,
    sampleCount: data.sampleCount,
    durationSeconds: data.durationSeconds,
    peaks,
    bands: Array.from({ length: channels }, () => new Uint8Array(0)),
  };
}
