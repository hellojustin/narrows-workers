#!/bin/bash
set -e

# Configuration
API_KEY="d470fa8f-4195-4cfa-9d44-a67b8f18533d"
API_URL="https://narrows.audiopond.net"
QUEUE_URL="https://sqs.us-east-1.amazonaws.com/897768183373/narrows-production-transcript-ingest"

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
