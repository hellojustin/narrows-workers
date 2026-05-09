#!/bin/bash
# Deletes chapters and segments for a list of episode IDs.
#
# Usage: ./cleanup-all.sh <episode-id> [<episode-id> ...]
#
# Required env vars (source from .env.production or export manually):
#   NARROWS_API_KEY, NARROWS_API_URL
set -e

API_KEY="${NARROWS_API_KEY:?Set NARROWS_API_KEY (e.g. source .env.production)}"
API_URL="${NARROWS_API_URL:?Set NARROWS_API_URL (e.g. source .env.production)}"

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <episode-id> [<episode-id> ...]" >&2
  exit 1
fi

EPISODES=("$@")

for epId in "${EPISODES[@]}"; do
  echo ""
  echo "=== Processing episode: $epId ==="
  
  # Delete chapters
  echo "Getting chapters..."
  curl -s "${API_URL}/api/v1/episodes/${epId}/chapters?limit=200" \
    -H "Authorization: Bearer ${API_KEY}" | jq -r '.data[].id' > /tmp/chapter_ids.txt
  
  chapterCount=$(wc -l < /tmp/chapter_ids.txt | tr -d ' ')
  echo "Deleting $chapterCount chapters..."
  while read id; do
    if [ -n "$id" ]; then
      curl -s -X DELETE "${API_URL}/api/v1/chapters/${id}" \
        -H "Authorization: Bearer ${API_KEY}" > /dev/null
      echo -n "."
    fi
  done < /tmp/chapter_ids.txt
  echo ""
  
  # Delete segments
  echo "Getting segments..."
  curl -s "${API_URL}/api/v1/episodes/${epId}/segments?limit=200" \
    -H "Authorization: Bearer ${API_KEY}" | jq -r '.data[].id' > /tmp/segment_ids.txt
  
  segmentCount=$(wc -l < /tmp/segment_ids.txt | tr -d ' ')
  echo "Deleting $segmentCount segments..."
  while read id; do
    if [ -n "$id" ]; then
      curl -s -X DELETE "${API_URL}/api/v1/segments/${id}" \
        -H "Authorization: Bearer ${API_KEY}" > /dev/null
      echo -n "."
    fi
  done < /tmp/segment_ids.txt
  echo ""
done

echo ""
echo "=== Verification ==="
for epId in "${EPISODES[@]}"; do
  chapters=$(curl -s "${API_URL}/api/v1/episodes/${epId}/chapters" \
    -H "Authorization: Bearer ${API_KEY}" | jq '.count')
  segments=$(curl -s "${API_URL}/api/v1/episodes/${epId}/segments" \
    -H "Authorization: Bearer ${API_KEY}" | jq '.count')
  echo "Episode $epId: $chapters chapters, $segments segments"
done

echo ""
echo "All cleanup complete!"
