#!/bin/bash
set -e

GRAPHITI_URL="http://graphiti.production.audiopond.net"

echo "=== Getting pending jobs ==="
curl -s "${GRAPHITI_URL}/jobs?status=pending&limit=500" | jq -r '.jobs[].id' > /tmp/pending_jobs.txt

count=$(wc -l < /tmp/pending_jobs.txt | tr -d ' ')
echo "Found $count pending jobs to cancel"

if [ "$count" -eq "0" ]; then
  echo "No pending jobs to cancel"
  exit 0
fi

echo "Cancelling jobs..."
cancelled=0
while read job_id; do
  if [ -n "$job_id" ]; then
    result=$(curl -s -X POST "${GRAPHITI_URL}/jobs/${job_id}/cancel" | jq -r '.success // "false"')
    if [ "$result" = "true" ]; then
      cancelled=$((cancelled + 1))
    fi
    echo -n "."
  fi
done < /tmp/pending_jobs.txt
echo ""

echo "Cancelled $cancelled jobs"

echo ""
echo "=== Verification ==="
curl -s "${GRAPHITI_URL}/status" | jq '.persistent_queue'
