import type { SQSEvent, SQSHandler } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

interface ImageDownloadMessage {
  type: "series" | "episode";
  id: string;
  imageUrl: string;
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
 * Update series with image media ID
 */
async function updateSeries(
  seriesId: string,
  imageMediaId: string
): Promise<void> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  await fetch(`${apiUrl}/api/v1/series/${seriesId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ imageMediaId }),
  });
}

/**
 * Update episode with image media ID
 */
async function updateEpisode(
  episodeId: string,
  imageMediaId: string
): Promise<void> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  await fetch(`${apiUrl}/api/v1/episodes/${episodeId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ imageMediaId }),
  });
}

/**
 * Extract file extension from URL or content type
 */
function getFileExtension(url: string, contentType: string): string {
  // Try to get from URL first
  try {
    const urlPath = new URL(url).pathname;
    const urlExt = urlPath.split(".").pop()?.toLowerCase();
    if (urlExt && ["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(urlExt)) {
      return urlExt === "jpeg" ? "jpg" : urlExt;
    }
  } catch {
    // URL parsing failed, continue to content type
  }

  // Fall back to content type
  const mimeToExt: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  };

  return mimeToExt[contentType] || "jpg";
}

/**
 * Get MIME type from extension
 */
function getMimeType(ext: string): string {
  const extToMime: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };

  return extToMime[ext] || "image/jpeg";
}

/**
 * Download image and upload to S3
 */
async function downloadAndUploadImage(
  imageUrl: string,
  mediaId: string,
  bucketName: string
): Promise<{ sizeKb: number; contentType: string; ext: string }> {
  console.log(`Downloading image from: ${imageUrl}`);

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "image/jpeg";
  const ext = getFileExtension(imageUrl, contentType);

  // Get the image data as ArrayBuffer
  const imageData = await response.arrayBuffer();
  const sizeKb = imageData.byteLength / 1024;

  console.log(`Downloaded ${sizeKb.toFixed(2)} KB (${ext}), uploading to S3...`);

  // Upload to S3 in raw/ folder
  const s3Key = `raw/${mediaId}`;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      Body: Buffer.from(imageData),
      ContentType: getMimeType(ext),
      Metadata: {
        "original-url": imageUrl,
        "original-extension": ext,
      },
    })
  );

  console.log(`Uploaded to s3://${bucketName}/${s3Key}`);

  return { sizeKb, contentType: getMimeType(ext), ext };
}

/**
 * Enqueue image for processing
 */
async function enqueueImageProcessing(mediaId: string, type: "series" | "episode", entityId: string): Promise<void> {
  const queueUrl = process.env.IMAGE_PROCESSING_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("IMAGE_PROCESSING_QUEUE_URL must be set");
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ mediaId, type, entityId }),
    })
  );
}

/**
 * Download Image Lambda
 *
 * Consumes from image-download-queue
 * Downloads series/episode artwork to S3
 * Creates Media record and updates Series/Episode
 * Enqueues to image-processing-queue
 */
export const main: SQSHandler = async (event: SQSEvent) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  const bucketName = process.env.MEDIA_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("MEDIA_BUCKET_NAME must be set");
  }

  for (const record of event.Records) {
    const message: ImageDownloadMessage = JSON.parse(record.body);
    const { type, id, imageUrl } = message;
    console.log(`Processing image download for ${type}: ${id}`);

    try {
      if (!imageUrl) {
        console.error(`No image URL provided for ${type} ${id}`);
        continue;
      }

      // 1. Create Media record
      const ext = getFileExtension(imageUrl, "image/jpeg");
      const fileName = `${type}-${id.slice(0, 8)}.${ext}`;

      const mediaId = await createMediaRecord({
        originalFileName: fileName,
        originalFileExt: ext,
        mimeType: getMimeType(ext),
        type: "image",
        originalFileSizeKb: 0, // Will be updated after download
      });

      console.log(`Created media record: ${mediaId}`);

      // 2. Download image and upload to S3
      const { sizeKb } = await downloadAndUploadImage(
        imageUrl,
        mediaId,
        bucketName
      );

      // 3. Update media record with actual file size
      await updateMediaRecord(mediaId, {
        originalFileSizeKb: sizeKb,
        uploadPctComplete: 1,
      });

      // 4. Update series or episode with image media ID
      if (type === "series") {
        await updateSeries(id, mediaId);
      } else {
        await updateEpisode(id, mediaId);
      }

      // 5. Enqueue for image processing
      await enqueueImageProcessing(mediaId, type, id);

      console.log(`Successfully processed image for ${type}: ${id}`);
    } catch (error) {
      console.error(`Error downloading image for ${type} ${id}:`, error);
      // Don't throw - image download failures shouldn't block the pipeline
      // The imageMediaId will remain null and we can retry later
    }
  }
};
