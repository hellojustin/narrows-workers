# HLS output specification

What the transcode step must produce. This is the contract the iOS, Android and web
clients depend on, and the contract the ffmpeg transcode Lambda has to satisfy to
replace MediaConvert.

Verify a real episode's output against this document with:

```
npx tsx scripts/verify-hls-output.ts <audioMediaId>
npx tsx scripts/verify-hls-output.ts <audioMediaId> --bucket audiopond-media-production
```

## Requirements

These are the parts that must not change. Anything else is an implementation detail.

| Property | Value |
| --- | --- |
| Audio codec | AAC-LC |
| Bitrate | 128 kbps |
| Sample rate | 48 000 Hz |
| Channels | 2 (stereo) |
| Target segment length | 10 s |
| Playlist type | VOD, with every segment listed |

Sources are normalised to these values rather than passed through. Podcast audio
arrives at anything from 32 kbps mono 22.05 kHz upward, so a mono 44.1 kHz source is
still published as stereo 48 kHz. A test covers that case specifically.

## S3 layout

Keys are derived from the audio media id. `generate-hls-subtitles/paths.ts` is the
single source for constructing them; nothing else should build these strings.

```
processed/{audioMediaId}/hls/
  {audioMediaId}.m3u8              master playlist
  {audioMediaId}_audio.m3u8        media playlist
  {audioMediaId}_audio_00000.ts    segments, 5-digit zero-padded, from 00000
  {audioMediaId}_audio_00001.ts
  ...
```

The `_audio` name modifier and the 5-digit padding come from the MediaConvert
configuration and are kept because the master playlist, the CDN paths and existing
episodes all use them.

**The master playlist must be written last.** Subtitle generation treats its presence
as the signal that HLS is complete, so publishing it before the segments would start
subtitle generation against a partial stream.

## Container

New output is MPEG-TS (`.ts`). Existing episodes are raw ADTS (`.aac`), which
MediaConvert produced. Both are correct HLS and both are verified to play; see
PROD-149 for the decision and PROD-152 for the playback results.

The catalogue therefore holds both, which is fine because each media playlist ships
next to its own segments and names them explicitly. No backfill is planned. A client
reads the playlist it is given and never assumes an extension.

## Differences from MediaConvert output

None of these affect playback. Recorded so that a diff between an old and a new
episode is not mistaken for a defect.

| | MediaConvert | ffmpeg |
| --- | --- | --- |
| Segment container | raw ADTS, `.aac` | MPEG-TS, `.ts` |
| Size, 9-min episode | 8.5 MB | 9.0 MB (5.9% larger) |
| First segment number | `00001` | `00000` |
| `EXT-X-PROGRAM-DATE-TIME` | every 600 s | absent |
| Encoder | Elemental | libavcodec AAC, arm64 |

The segment numbering start does not matter, because clients read filenames from the
playlist rather than generating them. The verifier accepts either start and checks
only that the sequence has no gaps, since a gap means a segment was lost between
transcode and upload and the client would get a 404 partway through the episode.

`EXT-X-PROGRAM-DATE-TIME` maps media time to wall-clock time. It matters for live
streams and for correlating playback with real-world timestamps. Nothing in Narrows
reads it: playback position is tracked in media time, and the listening analytics
pipeline timestamps events on the client.

Encoded bytes differ from MediaConvert, and would also differ between an arm64 and an
x86 ffmpeg build, because AAC encoders make different quantisation choices and
floating point differs across implementations. The requirement is the same bitrate,
segment length and encoding, not identical bytes.

## Consistency checks

The transcode Lambda applies these before uploading anything, so a broken stream is
never published.

- Every segment named in the playlist exists on disk.
- No segment is named twice.
- No segment on disk is missing from the playlist.
- The playlist's total duration is within one segment length of the probed source
  duration.

The last one catches a transcode that stopped early. A truncated run still produces a
structurally valid playlist, so without a duration check a half-length episode would
upload and look correct.

The duplicate and orphan checks exist because a parallel-chunking implementation hit
exactly that failure: two chunks claimed the same segment number, files overwrote each
other, and the playlist listed 931 entries against 928 files on disk. Playback skipped
audio silently. Chunking was dropped (PROD-156) but the checks were kept.

## Segment count

A segment boundary needs a frame boundary, so segments are close to 10 s rather than
exactly 10 s: `#EXTINF:9.984` is typical, since an AAC frame at 48 kHz is 1024 samples,
about 21.3 ms. The final segment is whatever is left over.

On the 9-minute reference episode ffmpeg produces 55 segments, matching MediaConvert
exactly.
