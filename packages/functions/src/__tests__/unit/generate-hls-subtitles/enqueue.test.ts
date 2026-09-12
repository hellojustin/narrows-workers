import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  s3Send: vi.fn(),
  sqsSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = mocks.s3Send;
  }
  class HeadObjectCommand {
    input: { Bucket: string; Key: string };
    type = "HeadObject";
    constructor(input: { Bucket: string; Key: string }) {
      this.input = input;
    }
  }
  return { S3Client, HeadObjectCommand };
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

import {
  tryEnqueueAfterMediaConvert,
  tryEnqueueAfterTranscode,
  tryEnqueueAfterTranscription,
} from "@/generate-hls-subtitles/enqueue";

const audioMediaId = "media-123";
const episodeId = "episode-456";
const bucketName = "test-bucket";
const queueUrl = "https://sqs.us-east-1.amazonaws.com/123/subtitle-generation";
const params = { episodeId, audioMediaId, bucketName, queueUrl };

const masterManifestKey = `processed/${audioMediaId}/hls/${audioMediaId}.m3u8`;
const transcriptKey = `processed/${audioMediaId}/transcript.json`;

/** S3 NotFound, in the shape the SDK actually throws. */
function notFound() {
  return Object.assign(new Error("NotFound"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function presentOnly(keys: string[]) {
  return (command: { input: { Key: string } }) =>
    keys.includes(command.input.Key) ? Promise.resolve({}) : Promise.reject(notFound());
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * These two functions are the whole coordination mechanism between transcoding and
 * transcription. Whichever finishes second sees the other's output in S3 and
 * enqueues subtitle generation. Nothing reads a job-completion event payload, which
 * is why the MediaConvert EventBridge rule can be dropped rather than replaced when
 * the ffmpeg transcode Lambda takes over.
 */
describe("tryEnqueueAfterTranscode", () => {
  it("enqueues when the transcript is already written", async () => {
    mocks.s3Send.mockImplementation(presentOnly([transcriptKey]));

    await tryEnqueueAfterTranscode(params);

    expect(mocks.sqsSend).toHaveBeenCalledTimes(1);
    const sent = mocks.sqsSend.mock.calls[0][0];
    expect(sent.input.QueueUrl).toBe(queueUrl);
    expect(JSON.parse(sent.input.MessageBody)).toEqual({ episodeId, audioMediaId });
  });

  it("does not enqueue when the transcript is not written yet", async () => {
    mocks.s3Send.mockImplementation(presentOnly([]));

    await tryEnqueueAfterTranscode(params);

    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it("checks the transcript key, not the manifest key", async () => {
    mocks.s3Send.mockImplementation(presentOnly([transcriptKey]));

    await tryEnqueueAfterTranscode(params);

    expect(mocks.s3Send.mock.calls[0][0].input.Key).toBe(transcriptKey);
  });

  it("propagates errors that are not 404, rather than treating them as absent", async () => {
    // An access-denied or throttling response must fail the handler so SQS retries.
    // Treating it as "not ready" would silently drop subtitle generation.
    mocks.s3Send.mockRejectedValue(
      Object.assign(new Error("AccessDenied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      })
    );

    await expect(tryEnqueueAfterTranscode(params)).rejects.toThrow(/AccessDenied/);
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });
});

describe("tryEnqueueAfterTranscription", () => {
  it("enqueues when the HLS master manifest already exists", async () => {
    mocks.s3Send.mockImplementation(presentOnly([masterManifestKey]));

    await tryEnqueueAfterTranscription(params);

    expect(mocks.sqsSend).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue when HLS is not ready", async () => {
    mocks.s3Send.mockImplementation(presentOnly([]));

    await tryEnqueueAfterTranscription(params);

    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it("checks the master manifest key", async () => {
    mocks.s3Send.mockImplementation(presentOnly([masterManifestKey]));

    await tryEnqueueAfterTranscription(params);

    expect(mocks.s3Send.mock.calls[0][0].input.Key).toBe(masterManifestKey);
  });
});

describe("the two sides together", () => {
  it("enqueues exactly once when transcription finishes first", async () => {
    // Transcription finishes: no HLS yet, so it does not enqueue.
    mocks.s3Send.mockImplementation(presentOnly([transcriptKey]));
    await tryEnqueueAfterTranscription(params);
    expect(mocks.sqsSend).not.toHaveBeenCalled();

    // Transcode finishes: the transcript is there, so it enqueues.
    mocks.s3Send.mockImplementation(presentOnly([transcriptKey, masterManifestKey]));
    await tryEnqueueAfterTranscode(params);
    expect(mocks.sqsSend).toHaveBeenCalledTimes(1);
  });

  it("enqueues exactly once when the transcode finishes first", async () => {
    mocks.s3Send.mockImplementation(presentOnly([masterManifestKey]));
    await tryEnqueueAfterTranscode(params);
    expect(mocks.sqsSend).not.toHaveBeenCalled();

    mocks.s3Send.mockImplementation(presentOnly([masterManifestKey, transcriptKey]));
    await tryEnqueueAfterTranscription(params);
    expect(mocks.sqsSend).toHaveBeenCalledTimes(1);
  });

  it("enqueues twice if both sides see the other's output, which the race allows", async () => {
    // Documenting known behaviour rather than asserting it is desirable. If both
    // finish close enough together that each sees the other, subtitle generation
    // runs twice. It is idempotent, so the outcome is the same output written twice.
    mocks.s3Send.mockImplementation(presentOnly([masterManifestKey, transcriptKey]));

    await tryEnqueueAfterTranscode(params);
    await tryEnqueueAfterTranscription(params);

    expect(mocks.sqsSend).toHaveBeenCalledTimes(2);
  });
});

describe("tryEnqueueAfterMediaConvert", () => {
  it("is the same function as tryEnqueueAfterTranscode", () => {
    // The alias keeps on-media-convert-complete working until MediaConvert is
    // decommissioned. If they ever diverge, one producer stops fanning in.
    expect(tryEnqueueAfterMediaConvert).toBe(tryEnqueueAfterTranscode);
  });
});
