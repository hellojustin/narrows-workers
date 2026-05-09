#!/bin/bash
# Required env vars (source from .env.production or export manually):
#   NARROWS_API_KEY, NARROWS_API_URL, TRANSCRIPT_INGEST_QUEUE_URL
set -e

API_KEY="${NARROWS_API_KEY:?Set NARROWS_API_KEY (e.g. source .env.production)}"
API_URL="${NARROWS_API_URL:?Set NARROWS_API_URL (e.g. source .env.production)}"
QUEUE_URL="${TRANSCRIPT_INGEST_QUEUE_URL:?Set TRANSCRIPT_INGEST_QUEUE_URL (output of sst deploy)}"

echo "=== Re-ingestion Script for All Episodes ==="
echo "API: $API_URL"
echo "Queue: $QUEUE_URL"
echo ""

# Get all episodes
echo "=== Fetching all episodes ==="
curl -s "${API_URL}/api/v1/episodes?limit=500" \
  -H "Authorization: Bearer ${API_KEY}" | jq -r '.data[] | "\(.id)|\(.title)"' > /tmp/all_episodes.txt

total=$(wc -l < /tmp/all_episodes.txt | tr -d ' ')
echo "Found $total episodes"
echo ""

# Confirm before proceeding
echo "This will queue $total episodes for re-ingestion."
echo "Each episode will be processed by the process-transcript Lambda."
read -p "Continue? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

echo ""
echo "=== Queueing episodes ==="
queued=0
failed=0

while IFS='|' read -r episode_id title; do
  if [ -n "$episode_id" ]; then
    # Send message to SQS
    result=$(aws sqs send-message \
      --queue-url "$QUEUE_URL" \
      --message-body "{\"episodeId\": \"$episode_id\"}" \
      2>&1)
    
    if echo "$result" | grep -q "MessageId"; then
      queued=$((queued + 1))
      echo "[$queued/$total] Queued: $title"
    else
      failed=$((failed + 1))
      echo "[$queued/$total] FAILED: $title - $result"
    fi
    
    # Small delay to avoid throttling
    sleep 0.1
  fi
done < /tmp/all_episodes.txt

echo ""
echo "=== Complete ==="
echo "Queued: $queued"
echo "Failed: $failed"
echo ""
echo "Monitor Lambda logs with:"
echo "  aws logs tail /aws/lambda/narrows-production-process-transcript --follow"
