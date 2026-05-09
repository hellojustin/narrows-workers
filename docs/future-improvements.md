# Future Improvements: Transcription Pipeline

This document tracks known improvements to the AssemblyAI transcription pipeline
that were deferred from the initial migration to keep scope manageable. They are
grouped by impact and complexity.

## 1. Partial Transcript Retrieval

**Status**: Deferred  
**Priority**: High — affects mobile performance and battery life

### Problem

Clients (mobile app, dashboard) currently download the entire `transcript.json`
from the CDN before they can render any transcript text. For a 2-hour episode,
`transcript.json` can be several megabytes. This:

- Slows initial transcript render (user sees nothing until fully downloaded)
- Wastes bandwidth on mobile connections
- Prevents efficient seek-based playback (loading the whole file just to jump to minute 45)

### Proposed Solution

Add a `GET /api/v1/episodes/:id/transcript` endpoint to the Narrows API that
accepts `startSec` and `endSec` query parameters and returns only the sentences
(and optionally words) in that time range.

```
GET /api/v1/episodes/:id/transcript?startSec=0&endSec=300
```

Response:
```json
{
  "sentences": [
    { "text": "...", "start_time": "0.0", "end_time": "5.23", "speaker_label": "spk_0" }
  ],
  "totalDuration": 3600
}
```

**Implementation options:**

1. **Read from S3 on demand**: The existing `transcript.json` file is already in
   S3. The endpoint streams and filters it. Low storage cost, but adds Lambda
   latency on every request.

2. **Store sentences in Postgres**: After writing `transcript.json`, also write
   each sentence as a row in a new `transcript_sentences` table (episodeId,
   startSec, endSec, text, speakerLabel). The endpoint queries by time range —
   `WHERE episode_id = ? AND start_sec >= ? AND end_sec <= ?`. Enables efficient
   range queries and pagination without reading S3.

3. **Chunked CDN files**: Split `transcript.json` into 5-minute chunk files
   at ingest time (`transcript-0.json`, `transcript-300.json`, ...). Clients
   fetch only the chunks they need. Simple, no API change, but requires chunk
   index awareness on the client.

Option 2 (Postgres) is likely the best fit given existing infrastructure, but
requires a DB migration in the narrows repo.

### Mobile client change

The mobile app would switch from loading the full CDN URL to fetching from the
API in small increments ahead of the playback cursor (e.g., the next 5 minutes).

---

## 2. Use AssemblyAI Sentences Endpoint Directly

**Status**: Deferred  
**Priority**: Medium — improves sentence quality, unblocks partial retrieval

### Problem

The current adapter uses AssemblyAI's `/sentences` endpoint to build
`audio_segments`, but synthesizes the `items` array (word-level) with a heuristic
punctuation splitter so the mobile app can split sentences client-side. This
duplication creates two sentence-splitting code paths that can drift.

The mobile app (`pond-mobile/lib/models/transcript.dart`) currently:
1. Fetches the full `transcript.json` from CDN
2. Parses `results.items` (word array with punctuation items)
3. Splits into `TranscriptSentence` objects using `TranscriptSentence.fromItems()`
   — splits on `.`, `?`, `!` punctuation items, with a 60-word forced-split safety valve

AssemblyAI's sentences endpoint already does this splitting more accurately using
semantic understanding. Our synthesized punctuation items are a best-effort approximation.

### Proposed Solution

1. **In `transcript.json`**: Add a top-level `sentences` array alongside `results`:
   ```json
   {
     "sentences": [
       { "text": "...", "start_time": "0.0", "end_time": "5.23", "speaker_label": "spk_0" }
     ],
     "results": { "audio_segments": [...], "items": [...] }
   }
   ```

2. **In the mobile app** (`Transcript.fromJson`): Check for `sentences` first;
   fall back to building from `results.items` for backward compatibility with
   old transcripts. This eliminates the heuristic splitter for new transcripts.

3. **Benefits**:
   - Eliminates the 60-word forced-split edge case
   - Handles abbreviations ("Dr. Smith", "U.S.A.") that trip up punctuation splitting
   - Single source of truth for sentence boundaries
   - Paves the way for partial transcript retrieval (sentences are the natural unit)

This is a backward-compatible change: old transcripts (AWS Transcribe format)
continue working via the `results.items` fallback.

---

## 3. AssemblyAI Native Speaker Identification

**Status**: Deferred  
**Priority**: Low-medium — could reduce LLM cost and latency

### Problem

The `process-transcript` pipeline uses GPT-4o via `identify-speakers.ts` to map
speaker labels (spk_0, spk_1) to human names and roles (host/guest). This costs
~$0.005–0.03 per episode and adds latency.

### AssemblyAI's Capability

AssemblyAI offers a Speaker Identification feature (`speaker_type: "name"` or
`speaker_type: "role"`) that can:

- Assign real speaker names when provided in the transcription request
- Auto-detect roles like "Interviewer" / "Interviewee" / "Agent" / "Customer"

However, for podcast use cases, speaker names typically aren't known at transcription
time (they come from episode metadata or episode description — the same source our
LLM uses). AssemblyAI's role detection may be less accurate than our GPT-4o approach
for podcast-specific roles (host vs. guest).

### Recommendation

Evaluate AssemblyAI's speaker identification on a sample of transcribed episodes
before replacing the LLM step. The current LLM approach uses series/episode metadata
context that AssemblyAI doesn't have access to, which likely gives better accuracy
for podcast content.

---

## 4. Universal-3 Pro Model Upgrade

**Status**: Deferred  
**Priority**: Low (cost vs. quality tradeoff)

### Details

AssemblyAI's Universal-3 Pro model offers higher accuracy than Universal-2, with
support for prompting/customization. Currently using Universal-2 for cost reasons.

To upgrade: change `speech_models: ["universal-2"]` to `speech_models: ["universal-3-pro", "universal-2"]`
in `start-processing/handler.ts`. The second model acts as a fallback for languages
Universal-3 Pro doesn't support.

Check current pricing at https://www.assemblyai.com/pricing before upgrading.

---

## 5. Webhook Authentication

**Status**: Deferred  
**Priority**: Low (internal risk only — webhook URL is not public-facing in docs)

### Problem

The `on-transcription-webhook` Lambda Function URL accepts POST requests from any
caller, not just AssemblyAI. A malicious actor who discovers the URL could
trigger fake completions.

### Solution

AssemblyAI supports custom auth headers on webhooks:

```typescript
// In startAssemblyAITranscription (start-processing/handler.ts):
body: JSON.stringify({
  audio_url: presignedUrl,
  speech_models: ["universal-2"],
  speaker_labels: true,
  webhook_url: webhookUrl,
  webhook_auth_header_name: "X-Webhook-Secret",
  webhook_auth_header_value: process.env.ASSEMBLYAI_WEBHOOK_SECRET,
})
```

The webhook handler then validates:
```typescript
const secret = event.headers["x-webhook-secret"];
if (secret !== process.env.ASSEMBLYAI_WEBHOOK_SECRET) {
  return { statusCode: 401, body: "Unauthorized" };
}
```

Add `ASSEMBLYAI_WEBHOOK_SECRET` to `.env.production` and `.env.example`,
and generate a random UUID as the value.

---

## 6. Remove Legacy AWS Transcribe Infrastructure

**Status**: Pending (after transition confirmed)

Once all in-flight AWS Transcribe jobs have completed (typically within 24h of
switching to AssemblyAI), remove:

1. `on-transcribe-complete` Lambda (`packages/functions/src/on-transcribe-complete/`)
2. Its definition in `infra/functions.ts` (`onTranscribeComplete`)
3. The `lambdaArns.onTranscribeComplete` export in `infra/functions.ts`
4. The `transcribePattern` from `infra/events.ts` `eventBridgeConfig`
5. The EventBridge rule created via AWS CLI (`aws events delete-rule ...`)
6. The `onTranscribeComplete` Lambda resource-based policy that allowed EventBridge to invoke it

To check for in-flight Transcribe jobs before removing:
```bash
aws transcribe list-transcription-jobs --status IN_PROGRESS --region us-east-1
```
