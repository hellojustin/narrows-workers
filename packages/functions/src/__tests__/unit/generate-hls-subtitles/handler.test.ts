import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  s3Send: vi.fn(),
  sqsSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = mocks.s3Send;
  }
  class GetObjectCommand {
    input: unknown;
    type = "GetObject";
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class PutObjectCommand {
    input: unknown;
    type = "PutObject";
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { S3Client, GetObjectCommand, PutObjectCommand };
});

vi.mock("@aws-sdk/client-sqs", () => {
  class SQSClient {
    send = mocks.sqsSend;
  }
  class SendMessageCommand {
    input: unknown;
    type = "SendMessage";
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { SQSClient, SendMessageCommand };
});

import { generateHlsSubtitles } from "@/generate-hls-subtitles/handler";

const audioMediaId = "media-123";
const episodeId = "episode-456";
const bucketName = "test-bucket";
const transcriptIngestQueueUrl = "https://sqs.us-east-1.amazonaws.com/123/transcript-ingest";

const masterManifest = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"
${audioMediaId}_audio.m3u8
`;

const audioPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10.000000,
segment00001.ts
#EXTINF:10.000000,
segment00002.ts
#EXT-X-ENDLIST
`;

const transcriptJson = JSON.stringify({
  results: {
    items: [
      {
        start_time: "1",
        end_time: "2",
        type: "pronunciation",
        alternatives: [{ confidence: "0.9", content: "Hello" }],
      },
      {
        start_time: "2",
        end_time: "2",
        type: "punctuation",
        alternatives: [{ confidence: "0.0", content: "." }],
      },
    ],
  },
});

describe("generateHlsSubtitles", () => {
  beforeEach(() => {
    mocks.s3Send.mockReset();
    mocks.sqsSend.mockReset();
  });

  it("skips when manifest already has subtitles", async () => {
    const patchedManifest = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="transcript.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=128000,SUBTITLES="subs"
${audioMediaId}_audio.m3u8
`;

    mocks.s3Send.mockResolvedValueOnce({
      Body: { transformToString: async () => patchedManifest },
    });

    await generateHlsSubtitles({
      episodeId,
      audioMediaId,
      bucketName,
      transcriptIngestQueueUrl,
    });

    expect(mocks.s3Send).toHaveBeenCalledTimes(1);
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it("generates subtitle files, patches manifest, and enqueues ingest", async () => {
    mocks.s3Send
      .mockResolvedValueOnce({
        Body: { transformToString: async () => masterManifest },
      })
      .mockResolvedValueOnce({
        Body: { transformToString: async () => audioPlaylist },
      })
      .mockResolvedValueOnce({
        Body: { transformToString: async () => transcriptJson },
      })
      .mockResolvedValue({});

    mocks.sqsSend.mockResolvedValue({});

    await generateHlsSubtitles({
      episodeId,
      audioMediaId,
      bucketName,
      transcriptIngestQueueUrl,
    });

    const putCalls = mocks.s3Send.mock.calls.filter((call) => call[0]?.type === "PutObject");
    expect(putCalls.length).toBeGreaterThanOrEqual(4);

    const manifestPut = putCalls.find((call) =>
      (call[0].input as { Key?: string }).Key?.endsWith(`${audioMediaId}.m3u8`)
    );
    expect((manifestPut?.[0].input as { Body?: string }).Body).toContain('SUBTITLES="subs"');

    expect(mocks.sqsSend).toHaveBeenCalledTimes(1);
    expect((mocks.sqsSend.mock.calls[0][0].input as { MessageBody?: string }).MessageBody).toBe(
      JSON.stringify({ episodeId })
    );
  });
});
