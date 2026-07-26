import type { SQSEvent, SQSHandler } from "aws-lambda";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  audioPlaylistKey,
  masterManifestKey,
  subtitlePlaylistKey,
  subtitleSegmentKey,
  transcriptJsonKey,
} from "./paths";
import {
  buildSentences,
  buildSubtitlePlaylist,
  generateSubtitleSegments,
  masterManifestHasSubtitles,
  parseAudioPlaylist,
  patchMasterManifest,
  type TranscriptItem,
} from "./webvtt";
import { isEpisodeIngestible } from "../shared/episode-guard";

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

interface SubtitleGenerationMessage {
  episodeId: string;
  audioMediaId: string;
}

async function readS3Text(bucket: string, key: string): Promise<string> {
  const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return (await response.Body?.transformToString()) ?? "";
}

async function writeS3Text(
  bucket: string,
  key: string,
  body: string,
  contentType: string
): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

/**
 * Generate HLS WebVTT subtitle segments from transcript.json and patch master manifest.
 */
export async function generateHlsSubtitles(params: {
  episodeId: string;
  audioMediaId: string;
  bucketName: string;
  transcriptIngestQueueUrl: string;
}): Promise<void> {
  const { episodeId, audioMediaId, bucketName, transcriptIngestQueueUrl } = params;

  const manifestKey = masterManifestKey(audioMediaId);
  const manifest = await readS3Text(bucketName, manifestKey);

  if (masterManifestHasSubtitles(manifest)) {
    console.log(`Subtitles already present in manifest for ${audioMediaId}, skipping`);
    return;
  }

  const audioPlaylist = await readS3Text(bucketName, audioPlaylistKey(audioMediaId));
  const segmentBoundaries = parseAudioPlaylist(audioPlaylist);

  if (segmentBoundaries.length === 0) {
    throw new Error(`No segments found in audio playlist for ${audioMediaId}`);
  }

  const transcriptRaw = await readS3Text(bucketName, transcriptJsonKey(audioMediaId));
  const transcriptJson = JSON.parse(transcriptRaw) as {
    results?: { items?: TranscriptItem[] };
  };
  const items = transcriptJson.results?.items ?? [];
  const sentences = buildSentences(items);

  const subtitleSegments = generateSubtitleSegments(sentences, segmentBoundaries);
  const subtitlePlaylist = buildSubtitlePlaylist(segmentBoundaries);

  await Promise.all([
    ...subtitleSegments.map((segment) =>
      writeS3Text(
        bucketName,
        subtitleSegmentKey(audioMediaId, segment.filename),
        segment.content,
        "text/vtt"
      )
    ),
    writeS3Text(
      bucketName,
      subtitlePlaylistKey(audioMediaId),
      subtitlePlaylist,
      "application/vnd.apple.mpegurl"
    ),
  ]);

  const patchedManifest = patchMasterManifest(manifest);
  if (patchedManifest) {
    await writeS3Text(
      bucketName,
      manifestKey,
      patchedManifest,
      "application/vnd.apple.mpegurl"
    );
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: transcriptIngestQueueUrl,
      MessageBody: JSON.stringify({ episodeId }),
    })
  );

  console.log(
    `Generated ${subtitleSegments.length} subtitle segments for ${audioMediaId}, enqueued transcript ingest`
  );
}

export const main: SQSHandler = async (event: SQSEvent) => {
  const bucketName = process.env.MEDIA_BUCKET_NAME;
  const transcriptIngestQueueUrl = process.env.TRANSCRIPT_INGEST_QUEUE_URL;

  if (!bucketName || !transcriptIngestQueueUrl) {
    throw new Error("MEDIA_BUCKET_NAME and TRANSCRIPT_INGEST_QUEUE_URL must be set");
  }

  for (const record of event.Records) {
    const message = JSON.parse(record.body) as SubtitleGenerationMessage;
    const { episodeId, audioMediaId } = message;

    if (!episodeId || !audioMediaId) {
      throw new Error("Missing episodeId or audioMediaId in message");
    }

    if (!(await isEpisodeIngestible(episodeId))) {
      console.log(
        `Skipping subtitle generation for episode ${episodeId}: not found or series opted out`
      );
      continue;
    }

    console.log(`Generating HLS subtitles for episode ${episodeId}, media ${audioMediaId}`);

    await generateHlsSubtitles({
      episodeId,
      audioMediaId,
      bucketName,
      transcriptIngestQueueUrl,
    });
  }
};
