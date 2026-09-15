# Transcode DLQ

Alarm: `narrows-production-audiotranscodedlqalarm` when `audio-transcode-dlq` has a visible message. Three receives have already failed.

## Inspect

```bash
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/897768183373/narrows-production-audio-transcode-dlq \
  --attribute-names ApproximateNumberOfMessages ApproximateAgeOfOldestMessage \
  --region us-east-1

aws sqs receive-message \
  --queue-url https://sqs.us-east-1.amazonaws.com/897768183373/narrows-production-audio-transcode-dlq \
  --max-number-of-messages 1 \
  --visibility-timeout 120 \
  --region us-east-1
```

The body is `{ "episodeId", "audioMediaId" }`. Check the episode row and CloudWatch logs for `narrows-production-transcode-audio` for that episode id.

## 403 vs timeout

- S3 403 on `HeadObject` of a missing key is the ListBucket gap (PROD-233). After that grant, a missing key is 404 and the fan-in waits. A 403 now is a real permission failure; do not swallow it.
- Duration near 900s is a timeout. Check episode length. Reserved concurrency is 3; a backlog is not a timeout.

## Redrive or drop

- Output in S3 is complete (`processed/{audioMediaId}/hls/{audioMediaId}.m3u8` exists): drop the DLQ message. The row may still be `failed` from the throw; set status back or redrive `processing` only if transcription also needs a restart.
- Output is missing or partial: admin redrive the episode. `redriveEpisode` sends transcode/ffmpeg errors to `processing`, which enqueues a new ffmpeg job and a new AssemblyAI submission.

```bash
# After a successful redrive, delete the DLQ copy so it does not alarm again.
aws sqs delete-message \
  --queue-url https://sqs.us-east-1.amazonaws.com/897768183373/narrows-production-audio-transcode-dlq \
  --receipt-handle REPLACE \
  --region us-east-1
```
