#!/bin/bash
set -e

API_KEY="d470fa8f-4195-4cfa-9d44-a67b8f18533d"
API_URL="https://narrows.audiopond.net"
EPISODE_ID="e70dd7e9-90cb-4d57-a94f-acf74277793d"

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
