#!/bin/bash
# Required env vars (source from .env.production or export manually):
#   NARROWS_API_KEY, NARROWS_API_URL
set -e

API_KEY="${NARROWS_API_KEY:?Set NARROWS_API_KEY (e.g. source .env.production)}"
API_URL="${NARROWS_API_URL:?Set NARROWS_API_URL (e.g. source .env.production)}"

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
