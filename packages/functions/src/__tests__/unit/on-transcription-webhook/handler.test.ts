import { describe, it, expect, vi, beforeEach } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

// Mock the shared complete-transcription module before importing handler
vi.mock("@/on-transcription-webhook/complete-transcription", () => ({
  completeTranscription: vi.fn().mockResolvedValue(undefined),
  updateEpisode: vi.fn().mockResolvedValue(undefined),
}));

import { main } from "@/on-transcription-webhook/handler";
import {
  completeTranscription,
  updateEpisode,
} from "@/on-transcription-webhook/complete-transcription";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(
  body: object,
  queryParams: Record<string, string> = {}
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: new URLSearchParams(queryParams).toString(),
    headers: { "content-type": "application/json" },
    queryStringParameters: queryParams,
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {} as never,
  };
}

function setEnv() {
  process.env.MEDIA_BUCKET_NAME = "test-bucket";
  process.env.ASSEMBLYAI_API_KEY = "test-api-key";
  process.env.TRANSCRIPT_INGEST_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/test/queue";
  process.env.NARROWS_API_URL = "https://narrows.example.com";
  process.env.NARROWS_API_KEY = "test-narrows-key";
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("on-transcription-webhook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
  });

  it("returns 400 when episodeId is missing from query params", async () => {
    const event = makeEvent(
      { transcript_id: "abc123", status: "completed" },
      { audioMediaId: "media-uuid" }
    );
    const result = await main(event);
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it("returns 400 when audioMediaId is missing from query params", async () => {
    const event = makeEvent(
      { transcript_id: "abc123", status: "completed" },
      { episodeId: "ep-uuid" }
    );
    const result = await main(event);
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it("returns 400 when body is invalid JSON", async () => {
    const event = makeEvent(
      {},
      { episodeId: "ep-uuid", audioMediaId: "media-uuid" }
    );
    // Override body with invalid JSON
    (event as { body: string }).body = "not-json{{";
    const result = await main(event);
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it("marks episode failed and returns 200 when status is error", async () => {
    const event = makeEvent(
      { transcript_id: "abc123", status: "error" },
      { episodeId: "ep-uuid", audioMediaId: "media-uuid" }
    );
    const result = await main(event);

    expect(result).toMatchObject({ statusCode: 200 });
    expect(updateEpisode).toHaveBeenCalledWith("ep-uuid", {
      processingStatus: "failed",
      processingError: "AssemblyAI transcription failed",
    });
    expect(completeTranscription).not.toHaveBeenCalled();
  });

  it("ignores intermediate statuses and returns 200", async () => {
    const event = makeEvent(
      { transcript_id: "abc123", status: "processing" },
      { episodeId: "ep-uuid", audioMediaId: "media-uuid" }
    );
    const result = await main(event);

    expect(result).toMatchObject({ statusCode: 200 });
    expect(updateEpisode).not.toHaveBeenCalled();
    expect(completeTranscription).not.toHaveBeenCalled();
  });

  it("calls completeTranscription with correct args on success", async () => {
    const event = makeEvent(
      { transcript_id: "abc123", status: "completed" },
      { episodeId: "ep-uuid", audioMediaId: "media-uuid" }
    );
    const result = await main(event);

    expect(result).toMatchObject({ statusCode: 200 });
    expect(completeTranscription).toHaveBeenCalledWith({
      transcriptId: "abc123",
      episodeId: "ep-uuid",
      audioMediaId: "media-uuid",
      assemblyApiKey: "test-api-key",
      bucketName: "test-bucket",
      transcriptIngestQueueUrl: "https://sqs.us-east-1.amazonaws.com/test/queue",
    });
    expect(updateEpisode).not.toHaveBeenCalled();
  });

  it("marks episode failed and returns 500 when completeTranscription throws", async () => {
    vi.mocked(completeTranscription).mockRejectedValueOnce(new Error("S3 write failed"));

    const event = makeEvent(
      { transcript_id: "abc123", status: "completed" },
      { episodeId: "ep-uuid", audioMediaId: "media-uuid" }
    );
    const result = await main(event);

    expect(result).toMatchObject({ statusCode: 500 });
    expect(updateEpisode).toHaveBeenCalledWith("ep-uuid", {
      processingStatus: "failed",
      processingError: "Transcription completion error: S3 write failed",
    });
  });

  it("returns 500 when required env vars are missing", async () => {
    delete process.env.MEDIA_BUCKET_NAME;

    const event = makeEvent(
      { transcript_id: "abc123", status: "completed" },
      { episodeId: "ep-uuid", audioMediaId: "media-uuid" }
    );
    const result = await main(event);

    expect(result).toMatchObject({ statusCode: 500 });
  });
});
