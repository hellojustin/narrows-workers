# Transcript window embedding format

Specification for `windows.bin`, the per-episode file of transcript-window embeddings. Graphiti's clip shaping (topic pipeline steps 8c and 8d, and the entity clip endpoint) reads these vectors to find where a clip's topic is first mentioned and where the conversation moves on, instead of embedding transcript windows itself.

Tracking: project "Entity clip shaping", PROD-263 (writer), PROD-266 (backfill), PROD-267 (graphiti reader).

## Decisions

| Item | Value |
| --- | --- |
| S3 key | `processed/{audioMediaId}/windows.bin` |
| Written by | `process-transcript`, before graphiti ingest |
| Source | `transcript.json` `results.audio_segments` (AssemblyAI sentences) |
| Window lengths | 10 s and 30 s |
| Window step | one sentence |
| Embedding model | `text-embedding-3-small` (`WINDOWS_EMBEDDING_MODEL`) |
| Dimensions | 1024 (`WINDOWS_EMBEDDING_DIM`) |
| Stored as | IEEE 754 half precision, rounded half to even |
| Byte order | little-endian throughout |
| Size | about 2.4 MB per hour of audio |
| Version | 1 |

The model and dimensions must equal graphiti's `EMBEDDING_MODEL_NAME` and `EMBEDDING_DIM`, because graphiti compares these vectors with topic and entity vectors it embeds itself. Graphiti treats a file whose header does not match its own settings as missing.

## Sentence list

Built from `transcript.results.audio_segments` so that the sentence timings match the cues graphiti builds from episodic `metadata.audio_segments`:

1. `start = parseFloat(start_time)`, `end = parseFloat(end_time)`. A sentence with either value not a number is skipped.
2. A sentence whose `transcript` is empty after trimming is skipped.
3. Duplicates by the pair (`start_time` string, `transcript`) are removed.
4. Sentences are sorted by `start`, keeping transcript order for equal starts.

Code: `packages/functions/src/process-transcript/windows/sentences.ts`.

## Windows

For each window length `L` and each sentence `i`, one window:

1. Take sentences `i`, `i+1`, … until `end[j] − start[i] >= L`. Sentence `j`, the one that reaches the length, is included.
2. If the transcript ends first, the window runs to the last sentence.
3. The text is the sentences' `transcript` values joined with one space, truncated to 8,000 characters.
4. The window's end time is `end[j]`.

This is the same rule as graphiti's `topic_mention.build_windows`, with one difference: graphiti cuts a window short at the edge of its scan region, and these windows always run their full length.

The windows include every sentence in the transcript, including ads and credits. Graphiti's own windows skipped segments that were never ingested (promotion, credits, sound-only, detected ads).

Code: `packages/functions/src/process-transcript/windows/build-windows.ts`.

## Binary form

| Offset | Size | Content |
| --- | --- | --- |
| 0 | 4 | ASCII `PWIN` |
| 4 | 2 | uint16 `formatVersion` = 1 |
| 6 | 2 | uint16 reserved = 0 |
| 8 | 4 | uint32 `headerLength` H (bytes of JSON) |
| 12 | H | UTF-8 JSON header |
| 12 + H | 0–7 | zero padding to the next multiple of 8 |
| `tableOffset` | N × 32 | sentence table |
| `rowsOffset` | N × `rowBytes` | vector rows |

### Header

```json
{
  "formatVersion": 1,
  "embeddingModel": "text-embedding-3-small",
  "embeddingDim": 1024,
  "dtype": "float16",
  "sentenceCount": 600,
  "windowSecs": [10, 30],
  "stepSentences": 1,
  "tableOffset": 320,
  "rowsOffset": 19520,
  "rowBytes": 4096,
  "transcriptSha256": "…",
  "generatedAt": "2026-09-29T00:00:00.000Z"
}
```

`transcriptSha256` is the SHA-256 of the JSON of the sentence list. A reader must use the stored offsets and must not compute them.

### Sentence table

Row `i` is four float64 values, in seconds from the start of the episode: `sentStart`, `sentEnd`, `win10End`, `win30End`. Both windows in row `i` start at `sentStart`.

### Vector rows

Row `i` is the 10 s window vector (`embeddingDim` float16 values) followed by the 30 s window vector. `rowBytes = 2 × embeddingDim × 2`.

Keeping both vectors for a sentence in one row lets a reader fetch every vector for a time range with one S3 range request: rows `i0` to `i1` are the bytes `rowsOffset + i0 × rowBytes` to `rowsOffset + i1 × rowBytes − 1`.

## S3 object metadata

| Key | Value |
| --- | --- |
| `format-version` | `1` |
| `embedding-model` | model name |
| `embedding-dim` | dimensions |
| `transcript-sha256` | as in the header |

`writeWindowsFile` skips an episode when an existing object's metadata matches all four values, so re-running ingest or the backfill does not re-embed unchanged transcripts. Pass `force` to rewrite.

## Failure handling

A failure to write `windows.bin` is logged as `WINDOWS_WRITE_FAILED` and does not fail transcript processing. Graphiti shapes clips for that episode without embeddings.

## Versioning

Any change to the layout, the sentence rules or the window rules increments `formatVersion`. A change of model or dimensions does not change the version; it changes the header values, and graphiti treats files with other values as missing until they are regenerated.

## Reference implementation

- Writer: `packages/functions/src/process-transcript/windows/`
- Fixture: `scripts/make-windows-fixture.ts` writes `windows_v1.bin` and `windows_v1.json` (12 sentences, 8 dimensions), used by graphiti's reader tests.
