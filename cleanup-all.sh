#!/bin/bash
set -e

API_KEY="d470fa8f-4195-4cfa-9d44-a67b8f18533d"
API_URL="https://narrows.audiopond.net"

# Episodes with existing data
EPISODES=(
  "3007c82c-0125-417a-a1ec-17aaf44b8de8"
  "523f49d6-5af4-428c-aa62-c30e1b459413"
  "fa87ebc1-9c91-4df7-8f45-88b3612ed542"
  "14b9a3cb-3588-4351-9114-954bba613167"
  "995caa3a-ee75-402b-ba25-15ed53e20465"
  "ef667d47-9f52-4817-98d4-3c14e0598c33"
  "b2480d78-a4d9-4cce-9802-97b5362a1c52"
)

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
