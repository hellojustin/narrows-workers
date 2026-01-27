import type { SQSEvent, SQSHandler } from "aws-lambda";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { Readable } from "stream";

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

interface AudioDownloadMessage {
  episodeId: string;
}

interface EpisodeData {
  id: string;
  seriesId: string;
  title: string;
  enclosureUrl: string;
  enclosureType: string;
  enclosureLength: number;
  audioMediaId: string | null;
}

/**
 * Fetch episode data from Narrows API
 */
async function fetchEpisode(episodeId: string): Promise<EpisodeData | null> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  const response = await fetch(`${apiUrl}/api/v1/episodes/${episodeId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch episode: ${response.statusText}`);
  }

  const { data } = await response.json();
  return data as EpisodeData;
}

/**
 * Create a media record via Narrows API
 */
async function createMediaRecord(mediaData: {
  originalFileName: string;
  originalFileExt: string;
  mimeType: string;
  type: string;
  originalFileSizeKb: number;
}): Promise<string> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  const response = await fetch(`${apiUrl}/api/v1/media`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(mediaData),
  });

  if (!response.ok) {
    throw new Error(`Failed to create media record: ${response.statusText}`);
  }

  const { data } = await response.json();
  return data.id;
}

/**
 * Update episode with media ID and processing status
 */
async function updateEpisode(
  episodeId: string,
  updates: {
    audioMediaId?: string;
    processingStatus?: string;
    processingError?: string;
  }
): Promise<void> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  await fetch(`${apiUrl}/api/v1/episodes/${episodeId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updates),
  });
}

/**
 * Update media record with final file size
 */
async function updateMediaRecord(
  mediaId: string,
  updates: {
    originalFileSizeKb?: number;
    uploadPctComplete?: number;
  }
): Promise<void> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  await fetch(`${apiUrl}/api/v1/media/${mediaId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updates),
  });
}

/**
 * Extract file extension from URL or content type
 */
function getFileExtension(url: string, contentType: string): string {
  // Try to get from URL first
  const urlPath = new URL(url).pathname;
  const urlExt = urlPath.split(".").pop()?.toLowerCase();
  if (urlExt && ["mp3", "m4a", "wav", "ogg", "aac", "flac"].includes(urlExt)) {
    return urlExt;
  }

  // Fall back to content type
  const mimeToExt: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/aac": "aac",
    "audio/flac": "flac",
  };

  return mimeToExt[contentType] || "mp3";
}

/**
 * Download audio file and upload to S3
 */
async function downloadAndUploadAudio(
  enclosureUrl: string,
  mediaId: string,
  bucketName: string
): Promise<{ sizeKb: number }> {
  console.log(`Downloading audio from: ${enclosureUrl}`);

  const response = await fetch(enclosureUrl);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "audio/mpeg";
  const contentLength = response.headers.get("content-length");

  // Get the audio data as ArrayBuffer
  const audioData = await response.arrayBuffer();
  const sizeKb = audioData.byteLength / 1024;

  console.log(`Downloaded ${sizeKb.toFixed(2)} KB, uploading to S3...`);

  // Upload to S3
  const s3Key = `raw/${mediaId}`;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      Body: Buffer.from(audioData),
      ContentType: contentType,
      Metadata: {
        "original-url": enclosureUrl,
      },
    })
  );

  console.log(`Uploaded to s3://${bucketName}/${s3Key}`);

  return { sizeKb };
}

/**
 * Enqueue episode for processing
 */
async function enqueueProcessing(episodeId: string, audioMediaId: string): Promise<void> {
  const queueUrl = process.env.PROCESSING_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("PROCESSING_QUEUE_URL must be set");
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ episodeId, audioMediaId }),
    })
  );
}

/**
 * Download Audio Lambda
 *
 * Consumes from audio-download-queue
 * Downloads audio from enclosureUrl to S3
 * Creates Media record and updates Episode
 * Enqueues to processing-queue
 */
export const main: SQSHandler = async (event: SQSEvent) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  const bucketName = process.env.MEDIA_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("MEDIA_BUCKET_NAME must be set");
  }

  for (const record of event.Records) {
    const message: AudioDownloadMessage = JSON.parse(record.body);
    const { episodeId } = message;
    console.log(`Processing audio download for episode: ${episodeId}`);

    try {
      // 1. Fetch episode from API
      const episode = await fetchEpisode(episodeId);
      if (!episode) {
        console.error(`Episode not found: ${episodeId}`);
        continue;
      }

      if (!episode.enclosureUrl) {
        console.error(`Episode ${episodeId} has no enclosure URL`);
        await updateEpisode(episodeId, {
          processingStatus: "failed",
          processingError: "No audio URL found in RSS feed",
        });
        continue;
      }

      // Skip if already has audio media
      if (episode.audioMediaId) {
        console.log(`Episode ${episodeId} already has audio media, skipping download`);
        await enqueueProcessing(episodeId, episode.audioMediaId);
        continue;
      }

      // Update status to downloading
      await updateEpisode(episodeId, { processingStatus: "downloading" });

      // 2. Create Media record
      const fileExt = getFileExtension(episode.enclosureUrl, episode.enclosureType || "audio/mpeg");
      const fileName = `${episode.title.slice(0, 100)}.${fileExt}`;

      const mediaId = await createMediaRecord({
        originalFileName: fileName,
        originalFileExt: fileExt,
        mimeType: episode.enclosureType || "audio/mpeg",
        type: "audio",
        originalFileSizeKb: (episode.enclosureLength || 0) / 1024,
      });

      console.log(`Created media record: ${mediaId}`);

      // 3. Download audio and upload to S3
      const { sizeKb } = await downloadAndUploadAudio(
        episode.enclosureUrl,
        mediaId,
        bucketName
      );

      // 4. Update media record with actual file size
      await updateMediaRecord(mediaId, {
        originalFileSizeKb: sizeKb,
        uploadPctComplete: 1,
      });

      // 5. Update episode with media ID
      await updateEpisode(episodeId, {
        audioMediaId: mediaId,
        processingStatus: "processing",
      });

      // 6. Enqueue for processing
      await enqueueProcessing(episodeId, mediaId);

      console.log(`Successfully processed audio for episode: ${episodeId}`);
    } catch (error) {
      console.error(`Error downloading audio for episode ${episodeId}:`, error);

      // Update episode with error
      await updateEpisode(episodeId, {
        processingStatus: "failed",
        processingError: error instanceof Error ? error.message : "Unknown error",
      });

      throw error;
    }
  }
};
