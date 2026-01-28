import type { SQSEvent, SQSHandler } from "aws-lambda";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";

const s3Client = new S3Client({});

interface ImageProcessingMessage {
  mediaId: string;
  type: "series" | "episode";
  entityId: string;
}

/**
 * Update media record to mark processing complete
 */
async function updateMediaRecord(
  mediaId: string,
  updates: {
    processedAt?: string;
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
 * Download image from S3
 */
async function downloadFromS3(
  bucketName: string,
  mediaId: string
): Promise<Buffer> {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: `raw/${mediaId}`,
    })
  );

  if (!response.Body) {
    throw new Error(`No body in S3 response for ${mediaId}`);
  }

  // Convert stream to buffer
  const chunks: Uint8Array[] = [];
  const stream = response.Body as AsyncIterable<Uint8Array>;
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Upload processed image to S3
 */
async function uploadToS3(
  bucketName: string,
  key: string,
  data: Buffer,
  contentType: string
): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: data,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
}

/**
 * Process Image Lambda
 *
 * Consumes from image-processing-queue
 * Downloads raw image from S3
 * Converts to base.png and base.jpg (no resizing)
 * Uploads processed images to S3 /processed/<media-id>/
 * Updates Media record with processed timestamp
 */
export const main: SQSHandler = async (event: SQSEvent) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  const bucketName = process.env.MEDIA_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("MEDIA_BUCKET_NAME must be set");
  }

  for (const record of event.Records) {
    const message: ImageProcessingMessage = JSON.parse(record.body);
    const { mediaId, type, entityId } = message;
    console.log(`Processing image for ${type} ${entityId}, mediaId: ${mediaId}`);

    try {
      // 1. Download raw image from S3
      console.log(`Downloading raw image from S3: raw/${mediaId}`);
      const rawImageBuffer = await downloadFromS3(bucketName, mediaId);
      console.log(`Downloaded ${rawImageBuffer.length} bytes`);

      // 2. Get image metadata
      const metadata = await sharp(rawImageBuffer).metadata();
      console.log(`Image metadata: ${metadata.width}x${metadata.height}, format: ${metadata.format}`);

      // 3. Convert to PNG
      console.log("Converting to PNG...");
      const pngBuffer = await sharp(rawImageBuffer)
        .png({ quality: 90, compressionLevel: 6 })
        .toBuffer();

      // 4. Convert to JPEG
      console.log("Converting to JPEG...");
      const jpgBuffer = await sharp(rawImageBuffer)
        .jpeg({ quality: 85, progressive: true })
        .toBuffer();

      // 5. Upload processed images to S3
      const processedPrefix = `processed/${mediaId}`;

      console.log(`Uploading base.png (${pngBuffer.length} bytes)...`);
      await uploadToS3(bucketName, `${processedPrefix}/base.png`, pngBuffer, "image/png");

      console.log(`Uploading base.jpg (${jpgBuffer.length} bytes)...`);
      await uploadToS3(bucketName, `${processedPrefix}/base.jpg`, jpgBuffer, "image/jpeg");

      // 6. Update media record with processed timestamp
      await updateMediaRecord(mediaId, {
        processedAt: new Date().toISOString(),
      });

      console.log(`Successfully processed image for ${type} ${entityId}`);
    } catch (error) {
      console.error(`Error processing image for ${type} ${entityId}:`, error);
      // Don't throw - image processing failures shouldn't cause retries that could
      // result in duplicate processing. Log the error and move on.
    }
  }
};
