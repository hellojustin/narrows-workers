# Narrows Workers Architecture

This document describes the architecture of the Narrows Workers serverless ingestion pipeline.

## Overview

Narrows Workers is an SST (Serverless Stack Toolkit) project that processes podcast episodes through a series of Lambda functions. The pipeline fetches RSS feeds, downloads audio and artwork, converts audio to HLS, transcribes, and ingests content into a knowledge graph. It also collects and aggregates listening events to build per-user taste profiles.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Infrastructure | SST v3 |
| Runtime | Node.js 20 |
| Language | TypeScript |
| Cloud | AWS (Lambda, SQS, EventBridge, S3) |
| LLM | OpenAI (gpt-4.1-mini, gpt-4o-mini) |
| Image processing | sharp, node-vibrant |
| RSS parsing | rss-parser |

## Project Structure

```
narrows-workers/
├── sst.config.ts              # SST configuration and queue URL outputs
├── vitest.config.ts           # Test configuration
├── infra/
│   ├── storage.ts             # S3 bucket reference
│   ├── queues.ts              # SQS queue definitions
│   ├── events.ts              # EventBridge cron schedules
│   ├── layers.ts              # ffmpeg Lambda layer
│   └── functions.ts           # Lambda function definitions
└── packages/functions/src/
    ├── fetch-rss/             # RSS feed fetching and episode upsert
    ├── download-audio/        # Audio file download to S3
    ├── download-image/        # Series/episode artwork download to S3
    ├── process-image/         # Image format conversion (PNG/JPEG) and color extraction
    ├── resize-image/          # On-demand image resizing (Function URL, CloudFront)
    ├── start-processing/      # Enqueue transcode-audio + AssemblyAI in parallel
    ├── transcode-audio/       # ffmpeg HLS transcode
    ├── analyze-audio/         # Waveform and per-frequency-band analysis
    ├── on-transcription-webhook/  # AssemblyAI completion: write transcript.json
    ├── generate-hls-subtitles/    # WebVTT + master playlist patch; fan-in to ingest
    ├── process-transcript/    # Main transcript processing pipeline
    │   ├── handler.ts         # Orchestrator
    │   ├── types.ts           # Type definitions
    │   ├── api-client.ts      # Narrows API client
    │   ├── identify-speakers.ts   # Speaker identification (LLM)
    │   ├── identify-chapters.ts   # Chapter detection (LLM)
    │   ├── identify-segments.ts   # Segment detection (LLM)
    │   └── ingest-to-graphiti.ts  # Graphiti ingestion
    ├── ingest-listening-events/   # SQS consumer: write listening events to Narrows API
    ├── rollup-listening/          # Hourly: aggregate listening events into summaries
    ├── build-taste-profiles/      # Every 5 min: compute per-user taste profiles
    ├── check-stale-transcriptions/ # Recover missed AssemblyAI webhooks
    └── discover-episodes/         # LLM current-events podcast discovery
```

## Pipeline Flow

### Audio ingestion

`start-processing` enqueues `transcode-audio` and starts AssemblyAI in parallel. It also enqueues `analyze-audio` (waveform); that path does not join the subtitle fan-in.

```
RSS Feed → fetch-rss → download-audio → start-processing
                  │                           │
                  │              ┌────────────┼────────────┐
                  │              ▼            ▼            ▼
                  │     transcode-audio   AssemblyAI   analyze-audio
                  │        (ffmpeg HLS)   (webhook)    (waveform)
                  │              │            │
                  │              │            ▼
                  │              │   on-transcription-webhook
                  │              │   writes transcript.json
                  │              │            │
                  │   tryEnqueueAfter        tryEnqueueAfter
                  │   Transcode              Transcription
                  │   HeadObject             HeadObject
                  │   transcript.json        master playlist
                  │              │            │
                  │              └─────┬──────┘
                  │                    ▼
                  │         generate-hls-subtitles
                  │         (whichever finishes second)
                  │                    ▼
                  │           process-transcript
                  │                    ▼
                  │           Graphiti /data API
                  │
                  └── download-image → process-image
                      (artwork)       (PNG/JPEG + colors)
```

`transcode-audio` writes HLS (segments, then the media playlist, then the master) and calls `tryEnqueueAfterTranscode`, which `HeadObject`s `transcript.json`. `on-transcription-webhook` writes `transcript.json` and calls `tryEnqueueAfterTranscription`, which `HeadObject`s the master playlist. Whichever side finishes second enqueues `generate-hls-subtitles`.

Completion is S3 object existence, not a job event. The transcode side treats `transcript.json` as “transcription is done.” The transcription side treats the HLS master playlist as “transcode is done.” The master must be written last so a `HeadObject` success cannot see a partial stream. `NotFound` / 404 means the other side is still running; any other error is a real failure. A custom EventBridge event from the transcode Lambda was rejected — the fan-in already is a `HeadObject` on the other side's output.

`check-stale-transcriptions` (15-minute cron) recovers a missed AssemblyAI webhook. If an episode has been in `processing` for more than 30 minutes and the HLS master is missing, it also re-enqueues `audio-transcode`.

MediaConvert and Transcribe Job State Change rules on the default EventBridge bus were deleted after the cutover. The procedure is in `docs/eventbridge-teardown.md`.

Output contracts: [HLS output specification](docs/hls-output-spec.md) and [waveform data format](docs/waveform-format.md).

### S3 layout

Production bucket: `audiopond-media-production` (`MEDIA_BUCKET_NAME`). Keys are derived from the media id. HLS key helpers live in `generate-hls-subtitles/paths.ts`.

```
raw/{audioMediaId}                         original download, no extension

processed/{audioMediaId}/
  transcript.json                          AssemblyAI; written by on-transcription-webhook
  waveform.bin                             always, from analyze-audio
  waveform-overview.bin                    always, decimated peaks
  waveform.json                            short episodes only
  windows.bin                              transcript-window embeddings, from process-transcript
  hls/
    {audioMediaId}.m3u8                    master playlist (written last)
    {audioMediaId}_audio.m3u8              media playlist
    {audioMediaId}_audio_NNNNN.ts          ffmpeg segments, from 00000
    {audioMediaId}_audio_NNNNN.aac         MediaConvert-era segments, from 00001
    transcript.m3u8                        WebVTT playlist
    transcript_NNNNN.vtt                   subtitle segments, from 00001

processed/{imageMediaId}/
  base.jpg
  base.png
```

Artwork uses a different media id than the audio. There is no progressive-download `audio.mp3` and no `hls/audio.m3u8`.

The catalogue holds both segment containers. New output is MPEG-TS (`.ts`). Episodes transcoded before the ffmpeg cutover are raw ADTS (`.aac`). Each media playlist names its own segments, so a client never assumes an extension. No backfill is planned. Decision: the HLS spec (PROD-149); playback of both forms: PROD-152.

Verified 2026-09-21 against CloudFront (`https://media.audiopond.net`):

- ffmpeg: Letters from an American, “Bacon’s Rebellion”, `audio_media_id` `b7cf02ee-fe21-479a-996c-f5f9bf3fe576`. Master, media playlist, `_audio_00000.ts`, `transcript.json`, `waveform.bin`, `waveform-overview.bin`, `transcript.m3u8`, `transcript_00001.vtt`, `raw/{id}`.
- MediaConvert-era: PBS News Hour, 2026-02-03, `audio_media_id` `47c4b8f8-ae09-47dc-93da-2afb6cb83516`. Same key pattern; first segment `_audio_00001.aac`.
- Artwork: series icon `f390ca55-70fa-4605-b972-f8c4c278763f` has `base.jpg` and `base.png`. Those files are not under the audio media prefix.

### Listening events

```
Narrows API (user playback) → SQS ListeningEventsQueue
                                        │
                               ingest-listening-events
                                        │
                               Narrows API /listening/ingest
                                        │
                          (hourly EventBridge cron)
                                        │
                               rollup-listening
                                        │
                               Narrows API /listening/summaries
                                        │
                       (every-5-min EventBridge cron)
                                        │
                               build-taste-profiles
                                        │
                       Graphiti entity lookup + Narrows API upsert
```

## Process Transcript Function

The `process-transcript` Lambda is the core processing function. It:

1. **Identifies Speakers** (LLM: gpt-4.1-mini)
   - Analyzes series/episode metadata and transcript samples
   - Maps speaker labels (spk_0, spk_1) to names and roles (host/guest)
   - Stores via `PUT /episodes/:id` with speakerData

2. **Identifies Chapters** (LLM: gpt-4.1-mini)
   - Divides episode into 5-15 chapters per hour
   - Chapters are non-overlapping and cover full duration
   - Types: introduction, credits, promotion, section, other
   - Stores via `PUT /chapters/:id`

3. **Identifies Segments** (LLM: gpt-4o-mini)
   - Creates up to ~8-30 segments per hour (~12/hour target; 30s–full chapter each; prefer fewer, longer)
   - Evaluates content metrics:
     - **Lucidity** (0-5): Clarity of expression
     - **Polarity** (-5 to +5): Sentiment
     - **Arousal** (0-5): Energy/intensity
     - **Subjectivity** (0-5): Fact vs opinion
     - **Humor** (0-5): Comedic intent
   - Types: show-intro, episode-intro, guest-intro, credits, promotion, summary, analysis, conclusion, sound-only, other
   - Stores via `PUT /segments/:id`

4. **Ingests to Graphiti**
   - Filters out ads (keyword scan + LLM classifier)
   - Uses Anthropic's contextual retrieval format
   - Sends segments to `POST /data` endpoint
   - Includes all metadata and metrics

### Transcript Structure (`transcript.json`)

```typescript
interface TranscriptSegment {
  id: string;
  start_time: string;  // e.g., "0.0"
  end_time: string;    // e.g., "5.23"
  transcript: string;
  speaker_label: string;  // e.g., "spk_0"
}

interface TranscriptResult {
  results: {
    audio_segments: TranscriptSegment[];
  };
}
```

### Contextual Retrieval Format

Each segment is sent to Graphiti with this format:

```xml
<document>
<context>Brief description for retrieval (1-3 sentences)</context>
<transcript>
[Speaker Name] Actual transcript content...
</transcript>
</document>
```

## SQS Queues

| Queue | Purpose | Visibility Timeout |
|-------|---------|---------|
| rss-refresh-queue | RSS fetch triggers | 5 min |
| audio-download-queue | Audio downloads | 11 min |
| image-download-queue | Series/episode artwork downloads | 6 min |
| image-processing-queue | Image format conversion | 6 min |
| processing-queue | Start transcode + transcription | 3 min |
| audio-transcode-queue | ffmpeg HLS transcode | 16 min |
| audio-analysis-queue | Waveform analysis | 16 min |
| subtitle-generation-queue | generate-hls-subtitles | 6 min |
| transcript-ingest-queue | process-transcript | 16 min |
| listening-events-queue | Listening event ingestion | 2 min |
| discovery-queue | discover-episodes | 11 min |

## EventBridge Schedules

| Schedule | Function | Purpose |
|----------|----------|---------|
| `rate(1 hour)` | rollup-listening | Aggregate raw listening events into per-user/episode summaries |
| `rate(5 minutes)` | build-taste-profiles | Compute and upsert user taste profiles from summaries + Graphiti entities |
| `rate(15 minutes)` | check-stale-transcriptions | Recover episodes whose AssemblyAI webhook was missed or whose handler failed |
| `rate(30 minutes)` | discover-episodes | LLM current-events discovery via PodcastIndex and Graphiti topic seeding |

These crons are SST constructs and run only in production (`infra/events.ts`).

MediaConvert and Transcribe Job State Change rules on the default bus were deleted after the cutover. See `docs/eventbridge-teardown.md`.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MEDIA_BUCKET_NAME` | S3 bucket for media storage |
| `NARROWS_API_URL` | Narrows API base URL |
| `NARROWS_API_KEY` | Narrows API authentication |
| `GRAPHITI_API_URL` | Graphiti API endpoint |
| `GRAPHITI_API_KEY` | Graphiti authentication |
| `GRAPHITI_GRAPH_ID` | Target graph ID |
| `OPENAI_API_KEY` | OpenAI API for LLM calls |
| `ASSEMBLYAI_API_KEY` | AssemblyAI speech-to-text |
| `VPC_SUBNET_IDS` | VPC subnets (for Graphiti VPC access) |
| `VPC_SECURITY_GROUP_IDS` | VPC security groups |
| `TZ` | Pinned to `UTC` for every function (see below) |

Environment files are gitignored. Copy `.env.example` to `.env.dev` or `.env.production` and fill in values.

### Time is always UTC

These handlers don't touch Postgres directly — they send time windows to narrows,
which buckets listening and revenue by UTC day to allocate podcaster payouts. A
window computed against a non-UTC local clock would shift those day boundaries
and misallocate money, so:

- `TZ: "UTC"` is set on every function in `infra/functions.ts`. Lambda already
  defaults to UTC; stating it keeps the boundary from moving if that default does.
- Derive instants and dates only from UTC-safe operations — epoch arithmetic,
  `toISOString()`, and `getUTC*()` getters. Never the local-time `Date`
  constructor or `getHours()`/`getDate()`-style local getters.
- `vitest.config.ts` runs the suite at `Pacific/Chatham`, a fractional
  date-line-crossing offset, so local-time date math fails a test rather than
  quietly shifting a boundary in production.

## Testing

Tests use Vitest and live under `packages/functions/src/__tests__/unit/`. Run with:

```bash
npm test            # run once
npm run test:watch  # watch mode
npm run test:coverage
```

Tests gate all deploy commands — `npm run deploy:production` runs `npm test` first.

## Deployment

```bash
# Deploy to a stage (tests run first)
npm run deploy:dev
npm run deploy:production

# Deploy without running tests
dotenv -e .env.production -- sst deploy --stage production

# Remove a deployment
npm run remove:dev
```

Workers-only changes (segment sizing, `MAX_DATA_CHARS`) do **not** require a Graphiti server rebuild. If SST reports a stale lock: `npx sst unlock --stage production`.

### Smoke checks (longer segments / Graphiti char cap)

After deploy, re-run or process one real episode through `process-transcript` and confirm:

1. Segment count drops vs prior (~half for a typical hour-long show; soft target ~12/hour, clamp 8–30).
2. Some segments approach chapter length (30s–full chapter is allowed).
3. Graphiti ingest logs rarely show `chunk 2/N` (payloads stay under 20k chars).
4. Spot-check 2–3 long chapters: boundaries align with content shifts; no empty tail from the old 6k transcript blind spot.

**Rollback:** revert the segment-target / prompt / `MAX_DATA_CHARS` edits in this repo and `npm run deploy:production`. No Graphiti redeploy needed.

## Related Repositories

- **narrows** (`../narrows`): Main API and dashboard (Next.js + Sequelize). Exposes the REST API that all Lambda functions call, and the user-facing web application.
- **graphiti**: Knowledge graph API (FastAPI). Stores segment text and entity relationships for search and recommendations.

## Specifications

- [HLS output specification](docs/hls-output-spec.md) — 128 kbps AAC-LC, 48 kHz stereo, 10 s segments, MPEG-TS for new output.
- [Waveform data format](docs/waveform-format.md) — `waveform.bin`, `waveform-overview.bin`, and optional `waveform.json`.
