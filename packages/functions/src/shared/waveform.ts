/**
 * Waveform analysis for episode audio: peak envelope plus per-band energy,
 * computed from interleaved s16le PCM without buffering the decoded file.
 *
 * Entry point for the analyze-audio function. The format written to S3 is
 * specified in docs/waveform-format.md.
 *
 * Typical use, with ffmpeg decoding the original audio to stdout:
 *
 *     const data = await analyzeS16lePcm(ffmpeg.stdout, { channels: 2 });
 *     const bin = encodeWaveformBinary(data);
 */

export {
  analyzeS16lePcm,
  WaveformAnalyzer,
  WAVEFORM_DEFAULTS,
  WAVEFORM_VERSION,
  type WaveformData,
  type WaveformOptions,
} from "./waveform-analyzer";

export {
  bandLevelsDb,
  computeBandBins,
  computeBandEdges,
  dequantiseDb,
  quantiseDb,
  type BandBinRange,
} from "./waveform-bands";

export {
  decodeWaveformBinary,
  encodeWaveformBinary,
  encodeWaveformJson,
  parseWaveformJson,
  toWaveformJson,
  WAVEFORM_BAND_BITS,
  WAVEFORM_HEADER_BYTES,
  WAVEFORM_MAGIC,
  WAVEFORM_PEAK_BITS,
  type WaveformJson,
} from "./waveform-encode";

export { Fft, hannWindow, windowPowerGain } from "./waveform-fft";
