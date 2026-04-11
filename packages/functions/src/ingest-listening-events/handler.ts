import type { SQSEvent, SQSHandler } from "aws-lambda";

const NARROWS_API_URL = process.env.NARROWS_API_URL;
const NARROWS_API_KEY = process.env.NARROWS_API_KEY;

interface ListeningEventMessage {
  userId: string;
  deviceId: string | null;
  events: {
    episodeId: string;
    clientEventId: string;
    startSec: number;
    endSec: number;
    playbackSpeed: number;
    listenedAt: string;
  }[];
}

export const main: SQSHandler = async (event: SQSEvent) => {
  console.log(`Processing ${event.Records.length} SQS record(s)`);

  for (const record of event.Records) {
    const message: ListeningEventMessage = JSON.parse(record.body);
    console.log(`Ingesting ${message.events.length} events for user ${message.userId}`);

    // Transform camelCase to snake_case for the narrows API
    const apiEvents = message.events.map((e) => ({
      user_id: message.userId,
      device_id: message.deviceId,
      episode_id: e.episodeId,
      client_event_id: e.clientEventId,
      start_sec: e.startSec,
      end_sec: e.endSec,
      playback_speed: e.playbackSpeed,
      listened_at: e.listenedAt,
    }));

    const response = await fetch(`${NARROWS_API_URL}/api/v1/internal/listening/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NARROWS_API_KEY}`,
      },
      body: JSON.stringify({ events: apiEvents }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Narrows API returned ${response.status}: ${text}`);
    }

    const result = await response.json();
    console.log(`Ingestion result: inserted=${result.inserted}, skipped=${result.skipped}, summaries=${result.summaries_updated}`);
  }
};
