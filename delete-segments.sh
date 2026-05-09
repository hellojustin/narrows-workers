#!/bin/bash
# Deletes all segments for a single episode.
#
# Usage: ./delete-segments.sh <episode-id>
#
# Required env vars (source from .env.production or export manually):
#   NARROWS_API_KEY, NARROWS_API_URL
set -e

API_KEY="${NARROWS_API_KEY:?Set NARROWS_API_KEY (e.g. source .env.production)}"
API_URL="${NARROWS_API_URL:?Set NARROWS_API_URL (e.g. source .env.production)}"
EPISODE_ID="${1:?Usage: $0 <episode-id>}"

echo "=== Getting segments ==="
curl -s "${API_URL}/api/v1/episodes/${EPISODE_ID}/segments?limit=200" \
  -H "Authorization: Bearer ${API_KEY}" | jq -r '.data[].id' > /tmp/segment_ids.txt

count=$(wc -l < /tmp/segment_ids.txt | tr -d ' ')
echo "Found $count segments to delete"

echo "Deleting segments..."
while read id; do
  curl -s -X DELETE "${API_URL}/api/v1/segments/${id}" \
    -H "Authorization: Bearer ${API_KEY}" > /dev/null
  echo -n "."
done < /tmp/segment_ids.txt
echo ""

echo "=== Verification ==="
echo -n "Segments remaining: "
curl -s "${API_URL}/api/v1/episodes/${EPISODE_ID}/segments" \
  -H "Authorization: Bearer ${API_KEY}" | jq '.count'

echo "Done!"
