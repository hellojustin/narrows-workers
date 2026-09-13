# Waveform data format

Specification for the waveform data Audiopond generates for every episode and
serves from the CDN, so client apps can draw a waveform scrubber. This is a new
capability; nothing in the system produced waveform data before it.

## Decisions

| Item | Value |
| --- | --- |
| Frame rate | 20 frames per second (2400-sample hop at 48 kHz) |
| Peak data | min and max sample per frame, per channel, signed 16-bit |
| Band data | 16 geometrically spaced bands, 40 Hz to 12 kHz, per channel |
| Band quantisation | 8 bits over 96 dB below full scale (0.376 dB per step) |
| Analysis window | 4096-point FFT, Hann window, centred on each frame |
| Serialisations | `waveform.bin` (binary, always), `waveform-overview.bin` (decimated peaks, always), and `waveform.json` (JSON, short episodes and debugging) |
| Byte order | Little-endian throughout |
| Data ordering | Frame-major within two sections, peaks then bands |
| Overview size | 2048 frames of peaks, about 16 KB, whatever the episode length |
| S3 keys | `processed/{audioMediaId}/waveform.bin`, `waveform-overview.bin`, `waveform.json` |
| Version | 1 |

Two kinds of data are stored per frame because clients need two renderings from
one file. The min/max pair draws the classic envelope. The 16 band levels draw a
spectral waveform, where the colour of each column comes from the distribution
of energy across frequency at that instant.

## Frame timing

`hopSamples = round(sampleRate / framesPerSecond)`. Frame `f` describes the time
bucket covering samples `[f * hopSamples, (f + 1) * hopSamples)`.

- Peaks are the minimum and maximum sample in that bucket. Nothing is
  interpolated and no sample is skipped, so a client drawing the envelope sees
  every transient in the source audio.
- Band levels come from an FFT window of `fftSize` samples centred on the bucket
  centre `f * hopSamples + hopSamples / 2`. The window therefore overlaps its
  neighbours (4096 samples of window per 2400 samples of hop) and is zero-padded
  where it extends past the start or end of the audio.
- `frameCount = ceil(sampleCount / hopSamples)`. The last frame can cover fewer
  than `hopSamples` samples; its peaks come from the samples that exist and its
  FFT window is zero-padded.

A client converts frame index to time as `f / framesPerSecond` for the start of
the bucket and `(f + 0.5) / framesPerSecond` for its centre.

## Frame rate

20 frames per second, meaning one frame per 50 ms.

The rate has to be high enough that a waveform drawn at normal zoom has more
data than pixels, and low enough that a long episode stays small. At 20 fps a
1000-pixel-wide view of a 30-second window has 600 frames behind it, so the
renderer downsamples rather than interpolates. Speech syllables land at roughly
4–8 per second, so 20 fps keeps syllable-level structure visible. Going to 50 fps
would multiply every size in this document by 2.5 for detail no scrubber shows.

The rate is not fixed by the format. `hopSamples` is stored in the header and
`framesPerSecond` is `sampleRate / hopSamples`. A reader must use the stored
values and must not assume 20. Changing the default rate for newly generated
episodes does not require a version bump, because old and new objects both
describe their own rate.

## Band edges

16 bands, geometrically spaced from 40 Hz to 12 kHz. Edge `i` of `bandCount + 1`
edges is `40 * (12000 / 40) ^ (i / 16)`, so each band spans
`log2(300) / 16 = 0.51` octaves.

The range covers what matters in podcast audio. Below 40 Hz there is rumble and
DC offset, not content. Above 12 kHz there is little energy in speech, and most
episodes reach us as lossy audio that has already been low-passed near or below
that point. 16 bands is the largest count that still fits one byte per band per
channel per frame in a file a mobile client will download.

Each band sums the FFT bins whose centre frequency falls inside it. At 4096
points and 48 kHz a bin is 11.72 Hz wide:

| Band | Range (Hz) | FFT bins | Bin count |
| --- | --- | --- | --- |
| 0 | 40.0 – 57.1 | 4–4 | 1 |
| 1 | 57.1 – 81.6 | 5–6 | 2 |
| 2 | 81.6 – 116.6 | 7–9 | 3 |
| 3 | 116.6 – 166.5 | 10–14 | 5 |
| 4 | 166.5 – 237.8 | 15–20 | 6 |
| 5 | 237.8 – 339.6 | 21–28 | 8 |
| 6 | 339.6 – 485.1 | 29–41 | 13 |
| 7 | 485.1 – 692.8 | 42–59 | 18 |
| 8 | 692.8 – 989.6 | 60–84 | 25 |
| 9 | 989.6 – 1413.4 | 85–120 | 36 |
| 10 | 1413.4 – 2018.7 | 121–172 | 52 |
| 11 | 2018.7 – 2883.4 | 173–246 | 74 |
| 12 | 2883.4 – 4118.3 | 247–351 | 105 |
| 13 | 4118.3 – 5882.2 | 352–501 | 150 |
| 14 | 5882.2 – 8401.6 | 502–716 | 215 |
| 15 | 8401.6 – 12000.0 | 717–1023 | 307 |

The two lowest bands hold one and two bins. That is a limit of the 4096-point
window, not of the band layout: a larger window would resolve them better at the
cost of smearing transients across more time. Bin 0 (DC) and the Nyquist bin are
never included in a band.

Levels are dBFS. A band's power is the sum of `|X[k]|^2` over its bins,
normalised by `4 / (fftSize^2 * g)` where `g` is the mean of the squared window
(0.375 for Hann). With that normalisation a full-scale sine inside a band reads
0 dBFS, which is the convention audio meters use. Silence reads at or below the
bottom of the quantisation range.

## Quantisation

8 bits per band value over 96 dB: level `0` means −96 dBFS or quieter, level
`255` means 0 dBFS, and the step is `96 / 255 = 0.376` dB.

```
level = clamp(round((dBFS + 96) / 96 * 255), 0, 255)
dBFS  = level / 255 * 96 - 96
```

96 dB is the dynamic range of the signed 16-bit PCM the analysis reads, so a
wider range would only encode values the input cannot express. A 0.376 dB step
is far finer than a colour ramp on a display can show, and 8 bits keeps the band
data byte-addressable, which is what makes the binary form simple to read from a
`Uint8Array` or a `ByteBuffer` with no bit shifting.

Peaks are not quantised. They are stored as signed 16-bit values in the same
scale as the source PCM (−32768 to 32767), which is exact and costs 4 bytes per
frame per channel.

## Channels

The channel count is whatever the analysis was fed: 2 for stereo, 1 for mono.
Mono input produces one channel; it is not duplicated, because duplicating it
doubles the file to carry no information. A client that draws two channels must
handle `channels == 1` by drawing the single channel.

The pipeline currently asks ffmpeg for `-ac 2`, which upmixes mono sources, so
production objects are stereo. Clients must not rely on that.

## JSON form

One object with the metadata as named fields and per-channel flat arrays. This
form exists for debugging, for tests, and for short episodes where its size is
not a problem. It is not the form a client should prefer.

```json
{
  "version": 1,
  "sampleRate": 48000,
  "channels": 2,
  "framesPerSecond": 20,
  "hopSamples": 2400,
  "fftSize": 4096,
  "bandCount": 16,
  "bandLowHz": 40,
  "bandHighHz": 12000,
  "bandEdgesHz": [40, 57.13, 81.6, "…", 12000],
  "bandBits": 8,
  "peakBits": 16,
  "dynamicRangeDb": 96,
  "frameCount": 10842,
  "durationSeconds": 542.08,
  "peaks": [[-4113, 3902, "…"], ["…"]],
  "bands": [[131, 118, "…"], ["…"]]
}
```

- `peaks[channel]` holds `frameCount * 2` values, ordered min then max for each
  frame.
- `bands[channel]` holds `frameCount * bandCount` values, frame-major: all 16
  bands of frame 0, then all 16 bands of frame 1.
- `bandEdgesHz` holds `bandCount + 1` values and is derived from `bandCount`,
  `bandLowHz`, and `bandHighHz`. It is written so a reader does not have to
  recompute it.

## Binary form

A 64-byte header, then a peak section, then a band section. All multi-byte
values are little-endian, which matches every client architecture we ship to and
the s16le PCM the analysis reads.

### Header

| Offset | Type | Field |
| --- | --- | --- |
| 0 | 4 bytes | Magic `APWF` (`0x41 0x50 0x57 0x46`) |
| 4 | uint16 | `version` |
| 6 | uint16 | `headerBytes` (64 in version 1) |
| 8 | uint32 | `sampleRate` |
| 12 | uint8 | `channels` |
| 13 | uint8 | `bandCount` |
| 14 | uint8 | `bandBits` (8) |
| 15 | uint8 | `peakBits` (16) |
| 16 | uint32 | `hopSamples` |
| 20 | uint32 | `fftSize` |
| 24 | uint32 | `frameCount` |
| 28 | float64 | `durationSeconds` |
| 36 | float32 | `bandLowHz` |
| 40 | float32 | `bandHighHz` |
| 44 | float32 | `dynamicRangeDb` |
| 48 | uint32 | `peaksOffset` (64 in version 1) |
| 52 | uint32 | `peaksBytes` (`frameCount * channels * 4`) |
| 56 | uint32 | `bandsOffset` |
| 60 | uint32 | `bandsBytes` (`frameCount * channels * bandCount`) |

Band edges are not stored; they are derived from `bandCount`, `bandLowHz`, and
`bandHighHz` with the formula above. `sampleCount` is not stored either;
`round(durationSeconds * sampleRate)` recovers it exactly at every duration and
sample rate we handle.

Sections are located through `peaksOffset` and `bandsOffset`, never by adding
fixed constants. A reader that follows this rule keeps working if the header
grows (see Versioning).

### Peak section

`frameCount * channels * 4` bytes. For each frame in order, for each channel in
order: int16 min, int16 max.

```
frame 0: [ch0 min][ch0 max][ch1 min][ch1 max]
frame 1: [ch0 min][ch0 max][ch1 min][ch1 max]
```

### Band section

`frameCount * channels * bandCount` bytes. For each frame in order, for each
channel in order, `bandCount` uint8 levels from band 0 up.

```
frame 0: [ch0 band0..band15][ch1 band0..band15]
frame 1: [ch0 band0..band15][ch1 band0..band15]
```

### Frame-major ordering

Both sections are frame-major (frame, then channel, then band) rather than
band-major (band, then frame).

A client renders a visible time window: frames `a` through `b` of every channel
and every band, for the range of the scrubber currently on screen, and again on
every zoom or scroll. Frame-major puts exactly that data in one contiguous byte
range — `bandsOffset + a * channels * bandCount` to
`bandsOffset + b * channels * bandCount` — so it can be read in one pass and, if
the client wants to avoid downloading a 13 MB file to draw the first minute,
requested with one HTTP range request. Band-major would place the 32
channel-and-band series for those frames in 32 separate strided ranges, which is
32 range requests or a full download.

Keeping peaks and bands in separate sections follows the same reasoning from the
other direction. Most rendering only needs the envelope, and the peak section is
a fifth of the file (2.6 MB against 10.5 MB for a 4h34m episode). A client that
draws only the envelope reads only that section, and a client that colours the
waveform reads both.

## Overview form

`waveform-overview.bin` is the same binary format carrying peaks only, decimated
to at most 2048 frames. It is written for every episode, at every duration.

It exists because range requests cover every view except one. Frame-major
ordering means any zoomed window is a few kilobytes, but a scrubber showing a
whole episode at once needs every frame, which is the entire peak section: 1.07
MB on a 117-minute episode to fill about a thousand pixels. The overview is that
view precomputed, and it is 16 KB.

| Header field | Value in an overview |
| --- | --- |
| `bandCount` | 0 |
| `bandsBytes` | 0 |
| `hopSamples` | the source's `hopSamples` times the decimation group |
| `frameCount` | `ceil(sourceFrameCount / group)`, at most 2048 |
| `durationSeconds`, `sampleRate`, `channels` | the same as the source |
| `fftSize`, `bandLowHz`, `bandHighHz` | inherited from the source analysis, with no band data to apply them to |

A reader needs no new code. The magic bytes, version, and header layout are
unchanged, and a reader that locates sections through `peaksOffset` and
`bandsOffset` finds an empty band section. It must not assume 20 fps, which the
Frame rate section already requires: the overview's rate is whatever
`sampleRate / hopSamples` gives, 0.29 fps on a 117-minute episode.

Measured on production objects:

| Episode | Source frames | Peak section | Overview | Group |
| --- | --- | --- | --- | --- |
| 2 min | 2,430 | 19 KB | 9,784 B | 2:1 |
| 42 min | 50,209 | 392 KB | 16,136 B | 25:1 |
| 55 min | 65,428 | 511 KB | 16,424 B | 32:1 |
| 117 min | 140,811 | 1,100 KB | 16,392 B | 69:1 |

### Decimation

Each output frame covers a whole number of input frames, so `hopSamples` stays
an exact multiple of the source's and an output frame maps onto a known span of
`waveform.bin`. A client that draws the overview and then zooms converts between
the two grids without a rounding rule.

Peaks are combined by taking the extremes of the group — the minimum of the
minima and the maximum of the maxima — not the mean. A mean pulls every
transient towards zero, which at 69:1 would render a two-hour episode as a flat
band. The extremes keep the envelope the same shape at every zoom level, and
guarantee the loudest moment in the episode appears in the overview.

Band levels are dropped rather than decimated. Spectral colour is four fifths of
the file, and a whole-episode scrubber does not draw it; a client that wants
colour range-requests the band bytes for the window it is showing.

Episodes short enough to fall under 2048 frames — below about 102 seconds at 20
fps — get a group of 1, so their overview is a copy of the peak section.

## Versioning

The format will change once a client renders it, so version detection comes
first, before any parsing.

- Binary: bytes 0–3 must equal `APWF`, then `version` is the uint16 at offset 4.
- JSON: the `version` field.

A reader that does not recognise the version must treat the waveform as
unavailable and render the screen without it. It must not parse the parts it
thinks it recognises. Any layout the reader was not written against can move
every field it depends on.

Rules for the producer:

- Increment `version` for any change to the meaning, ordering, size, or
  quantisation of existing fields, or to the framing of the sections.
- Additive changes may keep the version: appending new fields to the header
  (increasing `headerBytes`) and appending a new section after the existing ones.
  This is only safe because readers are required to locate sections through the
  offset fields and to skip to `headerBytes` rather than assuming 64. A reader
  that hardcodes 64 will break, and that is the reader's defect.
- Record the version alongside the episode in narrows, so a client can decide
  whether to fetch at all instead of downloading a file it cannot read.

## S3 object keys

Under the media bucket, beside the other derived artefacts for the same media
ID:

```
processed/{audioMediaId}/waveform.bin
processed/{audioMediaId}/waveform-overview.bin
processed/{audioMediaId}/waveform.json
```

This matches the existing layout, where `raw/{mediaId}` is the original audio
and everything derived from it lives under `processed/{mediaId}/`, alongside
`processed/{mediaId}/transcript.json` and `processed/{mediaId}/hls/`.

`waveform.bin` and `waveform-overview.bin` are written for every episode.
`waveform.json` is written only for
episodes of at most 20 minutes, set by `JSON_MAX_DURATION_SEC` in
`analyze-audio/handler.ts`. At that length it is about 3.3 MB, roughly 1.1 MB
gzipped. Above it only the binary form is stored, because JSON at full episode
length reaches 44.9 MB.

The narrows API applies the same 20-minute threshold when deciding whether to
advertise a `jsonUrl` to clients. The two thresholds have to agree: if the API's
were higher, clients would be given a URL for an object that was never written.

The unversioned keys always hold the current format version. If a future
breaking change has to be served at the same time as an older version for
clients that cannot read the new one, the new version goes to
`processed/{mediaId}/waveform.v{N}.bin` and the unversioned key stays at the
oldest version still supported.

## HTTP headers

| Object | Content-Type | Cache-Control |
| --- | --- | --- |
| `waveform.bin` | `application/octet-stream` | `public, max-age=31536000, immutable` |
| `waveform-overview.bin` | `application/octet-stream` | `public, max-age=31536000, immutable` |
| `waveform.json` | `application/json` | `public, max-age=31536000, immutable` |

The content is derived from an immutable media ID and never rewritten in place,
so a one-year immutable cache is correct and CloudFront does not need
invalidation. A new format version arrives as a new object, and a re-analysis of
the same audio produces the same bytes.

`Accept-Ranges: bytes` is required, since range requests are how a client fetches
one time window. S3 origins provide it, and the CloudFront distribution in front
of them passes it through: a request for bytes 0–63 of a 5.6 MB `waveform.bin`
returns `206` with 64 bytes.

Compression is worth having on the JSON form and is optional on the binary form.
Measured on a 9-minute episode: JSON 1,479,537 bytes compresses to 510,298 with
gzip -9 (34%), binary 433,744 bytes compresses to 248,264 (57%). CloudFront
compresses only the content types on its list, which includes `application/json`
but not `application/octet-stream`, so the binary form is served as stored. If
the transfer size matters more than the range-request behaviour, store a
precompressed copy with `Content-Encoding: gzip`; note that this makes byte
ranges refer to the compressed bytes, which defeats windowed fetching.

## Sizes

Per frame: `channels * 4` bytes of peaks and `channels * bandCount` bytes of
bands. Stereo at 20 fps with 16 bands is 40 bytes per frame, 800 bytes per
second of audio.

| Episode | Frames | Binary | Binary gzip | JSON | JSON gzip |
| --- | --- | --- | --- | --- | --- |
| 9m02s (measured) | 10,842 | 434 KB | 248 KB | 1.5 MB | 510 KB |
| 4h34m (extrapolated) | 328,800 | 13.2 MB | ~7.5 MB | ~44.9 MB | ~15.5 MB |

Those are whole-file sizes, and no client should be downloading them. What a
client actually transfers, measured against CloudFront on the 117-minute
episode `2482c72e`:

| Request | Bytes |
| --- | --- |
| Overview, for the scrubber | 16,392 |
| Header alone | 64 |
| 30 s window, envelope | 4,800 |
| 30 s window, envelope and spectral | 24,000 |
| Whole file | 5,632,504 |

The 4h34m figures are why the binary form exists. JSON at that length is 44.9 MB
for the same information, because every byte-sized band level becomes one to
three ASCII digits and a comma.

## Reference implementation

`packages/functions/src/shared/waveform.ts` and the `waveform-*.ts` modules
beside it: `waveform-fft.ts` (radix-2 FFT, Hann window),
`waveform-bands.ts` (band edges, bin assignment, dBFS, quantisation),
`waveform-analyzer.ts` (streaming analysis of interleaved s16le PCM),
`waveform-encode.ts` (both serialisations, in both directions), and
`waveform-overview.ts` (decimation to the overview form).

The analyzer consumes PCM incrementally and never holds the decoded audio: a
4h34m episode is about 3.2 GB of 48 kHz stereo PCM, which does not fit in a
Lambda. It is driven by piping ffmpeg's output into it:

```
ffmpeg -v error -i input -map 0:a:0 -f s16le -acodec pcm_s16le -ar 48000 -ac 2 -
```
