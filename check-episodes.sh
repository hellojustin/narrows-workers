#!/bin/bash
set -e

API_KEY="d470fa8f-4195-4cfa-9d44-a67b8f18533d"
API_URL="https://narrows.audiopond.net"

echo "=== Getting all episodes ==="
curl -s "${API_URL}/api/v1/episodes?limit=500" \
  -H "Authorization: Bearer ${API_KEY}" | jq -r '.data[].id' > /tmp/episode_ids.txt

count=$(wc -l < /tmp/episode_ids.txt | tr -d ' ')
echo "Found $count episodes"

echo ""
echo "=== Checking for chapters/segments ==="
while read epId; do
  chapters=$(curl -s "${API_URL}/api/v1/episodes/${epId}/chapters" \
    -H "Authorization: Bearer ${API_KEY}" | jq '.count')
  segments=$(curl -s "${API_URL}/api/v1/episodes/${epId}/segments" \
    -H "Authorization: Bearer ${API_KEY}" | jq '.count')
  
  if [ "$chapters" != "0" ] || [ "$segments" != "0" ]; then
    echo "Episode $epId: $chapters chapters, $segments segments"
  fi
done < /tmp/episode_ids.txt

echo ""
echo "Done!"
