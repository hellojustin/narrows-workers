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
| LLM | OpenAI (gpt-4o, gpt-4o-mini) |
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
│   ├── events.ts              # EventBridge rules and cron schedules
│   └── functions.ts           # Lambda function definitions
└── packages/functions/src/
    ├── fetch-rss/             # RSS feed fetching and episode upsert
    ├── download-audio/        # Audio file download to S3
    ├── download-image/        # Series/episode artwork download to S3
    ├── process-image/         # Image format conversion (PNG/JPEG) and color extraction
    ├── resize-image/          # On-demand image resizing (Function URL, CloudFront)
    ├── start-processing/      # Start MediaConvert & Transcribe in parallel
    ├── on-media-convert-complete/  # MediaConvert EventBridge event handler
    ├── on-transcribe-complete/     # Transcribe EventBridge event handler
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
    └── build-taste-profiles/      # Every 5 min: compute per-user taste profiles
```

## Pipeline Flow

### Audio ingestion

```
RSS Feed → fetch-rss → download-audio → start-processing
                  │                           │
                  │                 ┌─────────┴──────────┐
                  │                 ▼                     ▼
                  │        start-mediaconvert      start-transcribe
                  │                 │                     │
                  │           EventBridge             EventBridge
                  │                 │                     │
                  │    on-media-convert-complete  on-transcribe-complete
                  │                                       │
                  │                              process-transcript
                  │                                       │
                  │                              Graphiti /data API
                  │
                  └── download-image → process-image
                      (artwork)       (PNG/JPEG + colors)
```

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

1. **Identifies Speakers** (LLM: gpt-4o)
   - Analyzes series/episode metadata and transcript samples
   - Maps speaker labels (spk_0, spk_1) to names and roles (host/guest)
   - Stores via `PUT /episodes/:id` with speakerData

2. **Identifies Chapters** (LLM: gpt-4o)
   - Divides episode into 5-15 chapters per hour
   - Chapters are non-overlapping and cover full duration
   - Types: introduction, credits, promotion, section, other
   - Stores via `PUT /chapters/:id`

3. **Identifies Segments** (LLM: gpt-4o-mini)
   - Creates 20-60 segments per hour (30s-5min each)
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

### Transcript Structure (from AWS Transcribe)

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
| audio-download-queue | Audio downloads | 10 min |
| image-download-queue | Series/episode artwork downloads | 5 min |
| image-processing-queue | Image format conversion | 5 min |
| processing-queue | MediaConvert/Transcribe start | 2 min |
| transcript-ingest-queue | process-transcript | 16 min |
| listening-events-queue | Listening event ingestion | 2 min |

## EventBridge Schedules

| Schedule | Function | Purpose |
|----------|----------|---------|
| `rate(1 hour)` | rollup-listening | Aggregate raw listening events into per-user/episode summaries |
| `rate(5 minutes)` | build-taste-profiles | Compute and upsert user taste profiles from summaries + Graphiti entities |

MediaConvert and Transcribe completion events are routed from the **default EventBridge bus** via AWS CLI-managed rules (not SST constructs, since SST v3 lacks native support for default-bus subscriptions).

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
| `MEDIACONVERT_ENDPOINT` | AWS MediaConvert endpoint |
| `MEDIACONVERT_ROLE_ARN` | IAM role for MediaConvert |
| `VPC_SUBNET_IDS` | VPC subnets (for Graphiti VPC access) |
| `VPC_SECURITY_GROUP_IDS` | VPC security groups |

Environment files are gitignored. Copy `.env.example` to `.env.dev` or `.env.production` and fill in values.

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

## Related Repositories

- **narrows** (`../narrows`): Main API and dashboard (Next.js + Sequelize). Exposes the REST API that all Lambda functions call, and the user-facing web application.
- **graphiti**: Knowledge graph API (FastAPI). Stores segment text and entity relationships for search and recommendations.
