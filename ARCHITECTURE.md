# Narrows Workers Architecture

This document describes the architecture of the Narrows Workers serverless ingestion pipeline.

## Overview

Narrows Workers is an SST (Serverless Stack Toolkit) project that processes podcast episodes through a series of Lambda functions. The pipeline fetches RSS feeds, downloads audio, converts to HLS, transcribes, and ingests content into a knowledge graph.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Infrastructure | SST v3 |
| Runtime | Node.js 20 |
| Language | TypeScript |
| Cloud | AWS (Lambda, SQS, EventBridge, S3) |
| LLM | OpenAI (gpt-4o, gpt-4o-mini) |

## Project Structure

```
narrows-workers/
├── sst.config.ts              # SST configuration
├── infra/
│   ├── storage.ts             # S3 bucket reference
│   ├── queues.ts              # SQS queue definitions
│   ├── events.ts              # EventBridge rules
│   └── functions.ts           # Lambda function definitions
└── packages/functions/src/
    ├── fetch-rss/             # RSS feed fetching
    ├── download-audio/        # Audio file download
    ├── download-image/        # Image file download
    ├── process-image/         # Image processing (sharp)
    ├── resize-image/          # On-demand image resizing
    ├── start-processing/      # Start MediaConvert & Transcribe
    ├── on-media-convert-complete/  # MediaConvert event handler
    ├── on-transcribe-complete/     # Transcribe event handler
    └── process-transcript/    # Main transcript processing
        ├── handler.ts         # Orchestrator
        ├── types.ts           # Type definitions
        ├── api-client.ts      # Narrows API client
        ├── identify-speakers.ts   # Speaker identification
        ├── identify-chapters.ts   # Chapter detection
        ├── identify-segments.ts   # Segment detection
        └── ingest-to-graphiti.ts  # Graphiti ingestion
```

## Pipeline Flow

```
RSS Feed → fetch-rss → download-audio → start-processing
                                              │
                            ┌─────────────────┼─────────────────┐
                            ▼                 │                 ▼
                    start-media-convert       │         start-transcribe
                            │                 │                 │
                            ▼                 │                 ▼
                    EventBridge               │          EventBridge
                            │                 │                 │
                            ▼                 │                 ▼
              on-media-convert-complete       │   on-transcribe-complete
                                              │                 │
                                              │                 ▼
                                              │      process-transcript
                                              │                 │
                                              │                 ▼
                                              │         Graphiti API
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

| Queue | Purpose | Timeout |
|-------|---------|---------|
| rss-refresh-queue | RSS fetch triggers | 5 min |
| audio-download-queue | Audio downloads | 10 min |
| image-download-queue | Image downloads | 5 min |
| image-processing-queue | Image processing | 5 min |
| processing-queue | MediaConvert/Transcribe | 2 min |
| transcript-ingest-queue | process-transcript | 15 min |

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
| `VPC_SUBNET_IDS` | VPC subnets (for Graphiti access) |
| `VPC_SECURITY_GROUP_IDS` | VPC security groups |

## Deployment

```bash
# Deploy all functions
npx sst deploy --stage production

# Deploy specific stage
npx sst deploy --stage dev

# Remove deployment
npx sst remove --stage dev
```

## Related Repositories

- **narrows**: Main API and dashboard (Next.js)
- **graphiti**: Knowledge graph API (FastAPI)
