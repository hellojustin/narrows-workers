#!/bin/bash
# Deletes all chapters and segments for a single episode.
#
# Usage: ./cleanup.sh <episode-id>
#
# Required env vars (source from .env.production or export manually):
#   NARROWS_API_KEY, NARROWS_API_URL
set -e

API_KEY="${NARROWS_API_KEY:?Set NARROWS_API_KEY (e.g. source .env.production)}"
API_URL="${NARROWS_API_URL:?Set NARROWS_API_URL (e.g. source .env.production)}"
EPISODE_ID="${1:?Usage: $0 <episode-id>}"

echo "=== Getting chapters ==="
CHAPTERS=$(curl -s "${API_URL}/api/v1/episodes/${EPISODE_ID}/chapters" \
  -H "Authorization: Bearer ${API_KEY}" | jq -r '.data[].id')

echo "Deleting chapters..."
for id in $CHAPTERS; do
  echo "  Deleting chapter: $id"
  curl -s -X DELETE "${API_URL}/api/v1/chapters/${id}" \
    -H "Authorization: Bearer ${API_KEY}" > /dev/null
done

echo "=== Getting segments ==="
SEGMENTS=$(curl -s "${API_URL}/api/v1/episodes/${EPISODE_ID}/segments" \
  -H "Authorization: Bearer ${API_KEY}" | jq -r '.data[].id')

echo "Deleting segments..."
for id in $SEGMENTS; do
  echo "  Deleting segment: $id"
  curl -s -X DELETE "${API_URL}/api/v1/segments/${id}" \
    -H "Authorization: Bearer ${API_KEY}" > /dev/null
done

echo "=== Verification ==="
echo -n "Chapters: "
curl -s "${API_URL}/api/v1/episodes/${EPISODE_ID}/chapters" \
  -H "Authorization: Bearer ${API_KEY}" | jq '.count'
echo -n "Segments: "
curl -s "${API_URL}/api/v1/episodes/${EPISODE_ID}/segments" \
  -H "Authorization: Bearer ${API_KEY}" | jq '.count'

echo "Done!"
