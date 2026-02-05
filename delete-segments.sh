#!/bin/bash
set -e

API_KEY="d470fa8f-4195-4cfa-9d44-a67b8f18533d"
API_URL="https://narrows.audiopond.net"
EPISODE_ID="e70dd7e9-90cb-4d57-a94f-acf74277793d"

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
