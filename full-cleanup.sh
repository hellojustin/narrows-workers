#!/bin/bash
# Full cleanup script before re-ingestion
# This script:
# 1. Cancels all pending/processing Graphiti jobs
# 2. Clears the Graphiti graph
# 3. Deletes all chapters and segments from Narrows

set -e

# Configuration
NARROWS_API_URL="https://narrows.audiopond.net"
NARROWS_API_KEY="d470fa8f-4195-4cfa-9d44-a67b8f18533d"
GRAPHITI_API_URL="http://graphiti.production.audiopond.net"
GRAPHITI_GRAPH_ID="5683c474-61b6-4766-93de-9608316124dc"
SQS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/897768183373/narrows-production-transcript-ingest"

echo "=========================================="
echo "Full Cleanup Script"
echo "=========================================="
echo ""

# --- STEP 0: Purge SQS Queue ---
echo "--- Step 0: Purging SQS Queue ---"

# Get approximate message count
SQS_ATTRS=$(aws sqs get-queue-attributes --queue-url "$SQS_QUEUE_URL" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible 2>/dev/null || echo "{}")
VISIBLE=$(echo "$SQS_ATTRS" | jq -r '.Attributes.ApproximateNumberOfMessages // "0"')
IN_FLIGHT=$(echo "$SQS_ATTRS" | jq -r '.Attributes.ApproximateNumberOfMessagesNotVisible // "0"')

echo "SQS Queue: $SQS_QUEUE_URL"
echo "  Messages waiting: $VISIBLE"
echo "  Messages in-flight: $IN_FLIGHT"

if [ "$VISIBLE" != "0" ] || [ "$IN_FLIGHT" != "0" ]; then
    read -p "Purge the SQS queue? This will stop any pending Lambda invocations. (y/n): " CONFIRM
    if [ "$CONFIRM" = "y" ]; then
        echo "Purging SQS queue..."
        aws sqs purge-queue --queue-url "$SQS_QUEUE_URL" 2>/dev/null && echo "Queue purged successfully" || echo "Purge initiated (may take up to 60 seconds)"
        echo "Waiting 10 seconds for in-flight messages to complete..."
        sleep 10
    else
        echo "Skipping SQS purge."
    fi
else
    echo "SQS queue is empty."
fi

echo ""
echo "--- Step 0 Complete ---"
echo ""

# --- STEP 1: Cancel Graphiti Jobs ---
echo "--- Step 1: Canceling Graphiti Jobs ---"

# Get pending jobs
echo "Fetching pending jobs..."
PENDING_JOBS=$(curl -s "${GRAPHITI_API_URL}/jobs?status=pending&limit=1000" | jq -r '.jobs[].id // empty' 2>/dev/null || echo "")
PENDING_COUNT=$(echo "$PENDING_JOBS" | grep -c . 2>/dev/null || echo "0")
echo "Found $PENDING_COUNT pending jobs"

# Get processing jobs
echo "Fetching processing jobs..."
PROCESSING_JOBS=$(curl -s "${GRAPHITI_API_URL}/jobs?status=processing&limit=1000" | jq -r '.jobs[].id // empty' 2>/dev/null || echo "")
PROCESSING_COUNT=$(echo "$PROCESSING_JOBS" | grep -c . 2>/dev/null || echo "0")
echo "Found $PROCESSING_COUNT processing jobs"

# Get dead letter jobs
echo "Fetching dead letter jobs..."
DEAD_JOBS=$(curl -s "${GRAPHITI_API_URL}/jobs/dead-letter?limit=1000" | jq -r '.jobs[].id // empty' 2>/dev/null || echo "")
DEAD_COUNT=$(echo "$DEAD_JOBS" | grep -c . 2>/dev/null || echo "0")
echo "Found $DEAD_COUNT dead letter jobs"

TOTAL_JOBS=$((PENDING_COUNT + PROCESSING_COUNT))
echo ""
echo "Total jobs to cancel: $TOTAL_JOBS"

if [ "$TOTAL_JOBS" -gt 0 ]; then
    read -p "Cancel all $TOTAL_JOBS jobs? (y/n): " CONFIRM
    if [ "$CONFIRM" != "y" ]; then
        echo "Aborting."
        exit 1
    fi
    
    # Cancel pending jobs
    if [ -n "$PENDING_JOBS" ] && [ "$PENDING_JOBS" != "" ]; then
        echo "Canceling pending jobs..."
        CANCEL_COUNT=0
        for JOB_ID in $PENDING_JOBS; do
            curl -s -X POST "${GRAPHITI_API_URL}/jobs/${JOB_ID}/cancel" > /dev/null
            CANCEL_COUNT=$((CANCEL_COUNT + 1))
            if [ $((CANCEL_COUNT % 50)) -eq 0 ]; then
                echo "  Canceled $CANCEL_COUNT pending jobs..."
            fi
        done
        echo "  Canceled $CANCEL_COUNT pending jobs"
    fi
    
    # Cancel processing jobs
    if [ -n "$PROCESSING_JOBS" ] && [ "$PROCESSING_JOBS" != "" ]; then
        echo "Canceling processing jobs..."
        CANCEL_COUNT=0
        for JOB_ID in $PROCESSING_JOBS; do
            curl -s -X POST "${GRAPHITI_API_URL}/jobs/${JOB_ID}/cancel" > /dev/null
            CANCEL_COUNT=$((CANCEL_COUNT + 1))
        done
        echo "  Canceled $CANCEL_COUNT processing jobs"
    fi
fi

echo ""
echo "--- Step 1 Complete ---"
echo ""

# Wait a moment for any in-flight operations to complete
echo "Waiting 5 seconds for in-flight operations to settle..."
sleep 5

# --- STEP 2: Clear the Graphiti Graph ---
echo "--- Step 2: Clearing Graphiti Graph ---"

# Check current node count
echo "Checking current graph status..."
NODE_COUNT=$(curl -s "${GRAPHITI_API_URL}/status" | jq -r '.total_nodes // 0' 2>/dev/null || echo "unknown")
echo "Current node count: $NODE_COUNT"

read -p "Clear the entire Graphiti graph? This is irreversible! (y/n): " CONFIRM
if [ "$CONFIRM" != "y" ]; then
    echo "Skipping graph clear."
else
    echo "Clearing graph..."
    CLEAR_RESULT=$(curl -s -X POST "${GRAPHITI_API_URL}/clear" 2>&1)
    echo "Clear result: $CLEAR_RESULT"
    
    # Verify
    sleep 2
    NODE_COUNT=$(curl -s "${GRAPHITI_API_URL}/status" | jq -r '.total_nodes // 0' 2>/dev/null || echo "unknown")
    echo "Node count after clear: $NODE_COUNT"
fi

echo ""
echo "--- Step 2 Complete ---"
echo ""

# --- STEP 3: Delete Narrows Chapters and Segments ---
echo "--- Step 3: Deleting Narrows Chapters and Segments ---"

# Fetch all episodes
echo "Fetching episodes from Narrows..."
EPISODES=$(curl -s -H "Authorization: Bearer ${NARROWS_API_KEY}" "${NARROWS_API_URL}/api/v1/episodes?limit=500" | jq -r '.data[].id // empty' 2>/dev/null)
EPISODE_COUNT=$(echo "$EPISODES" | grep -c . 2>/dev/null || echo "0")
echo "Found $EPISODE_COUNT episodes"

# Count total chapters and segments
TOTAL_CHAPTERS=0
TOTAL_SEGMENTS=0

echo "Counting chapters and segments..."
for EPISODE_ID in $EPISODES; do
    CHAPTER_COUNT=$(curl -s -H "Authorization: Bearer ${NARROWS_API_KEY}" "${NARROWS_API_URL}/api/v1/episodes/${EPISODE_ID}/chapters" | jq '.data | length' 2>/dev/null || echo "0")
    SEGMENT_COUNT=$(curl -s -H "Authorization: Bearer ${NARROWS_API_KEY}" "${NARROWS_API_URL}/api/v1/episodes/${EPISODE_ID}/segments" | jq '.data | length' 2>/dev/null || echo "0")
    if [ "$CHAPTER_COUNT" != "0" ] && [ "$CHAPTER_COUNT" != "null" ]; then
        TOTAL_CHAPTERS=$((TOTAL_CHAPTERS + CHAPTER_COUNT))
    fi
    if [ "$SEGMENT_COUNT" != "0" ] && [ "$SEGMENT_COUNT" != "null" ]; then
        TOTAL_SEGMENTS=$((TOTAL_SEGMENTS + SEGMENT_COUNT))
    fi
done

echo "Total chapters: $TOTAL_CHAPTERS"
echo "Total segments: $TOTAL_SEGMENTS"

if [ "$TOTAL_CHAPTERS" -eq 0 ] && [ "$TOTAL_SEGMENTS" -eq 0 ]; then
    echo "No chapters or segments to delete."
else
    read -p "Delete all $TOTAL_CHAPTERS chapters and $TOTAL_SEGMENTS segments? (y/n): " CONFIRM
    if [ "$CONFIRM" != "y" ]; then
        echo "Skipping deletion."
    else
        DELETED_CHAPTERS=0
        DELETED_SEGMENTS=0
        
        for EPISODE_ID in $EPISODES; do
            # Delete chapters
            CHAPTER_IDS=$(curl -s -H "Authorization: Bearer ${NARROWS_API_KEY}" "${NARROWS_API_URL}/api/v1/episodes/${EPISODE_ID}/chapters" | jq -r '.data[].id // empty' 2>/dev/null)
            for CHAPTER_ID in $CHAPTER_IDS; do
                curl -s -X DELETE -H "Authorization: Bearer ${NARROWS_API_KEY}" "${NARROWS_API_URL}/api/v1/chapters/${CHAPTER_ID}" > /dev/null
                DELETED_CHAPTERS=$((DELETED_CHAPTERS + 1))
            done
            
            # Delete segments
            SEGMENT_IDS=$(curl -s -H "Authorization: Bearer ${NARROWS_API_KEY}" "${NARROWS_API_URL}/api/v1/episodes/${EPISODE_ID}/segments" | jq -r '.data[].id // empty' 2>/dev/null)
            for SEGMENT_ID in $SEGMENT_IDS; do
                curl -s -X DELETE -H "Authorization: Bearer ${NARROWS_API_KEY}" "${NARROWS_API_URL}/api/v1/segments/${SEGMENT_ID}" > /dev/null
                DELETED_SEGMENTS=$((DELETED_SEGMENTS + 1))
            done
            
            if [ $((DELETED_CHAPTERS + DELETED_SEGMENTS)) -gt 0 ] && [ $(((DELETED_CHAPTERS + DELETED_SEGMENTS) % 100)) -eq 0 ]; then
                echo "  Deleted $DELETED_CHAPTERS chapters, $DELETED_SEGMENTS segments..."
            fi
        done
        
        echo "Deleted $DELETED_CHAPTERS chapters and $DELETED_SEGMENTS segments"
    fi
fi

echo ""
echo "--- Step 3 Complete ---"
echo ""

echo "=========================================="
echo "Full Cleanup Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Make sure Graphiti is redeployed with the metadata fix"
echo "2. Run ./reingest-all-episodes.sh to queue all episodes for re-ingestion"
