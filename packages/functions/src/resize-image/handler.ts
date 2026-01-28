import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";

const s3Client = new S3Client({});

/**
 * Parse the image request path and query parameters
 * Path format: /image/<media-id>.<format>
 * Query params: w (width), h (height)
 */
function parseRequest(event: APIGatewayProxyEventV2): {
  mediaId: string;
  format: "jpg" | "png" | "webp";
  width?: number;
  height?: number;
} | null {
  const path = event.rawPath || "";
  const match = path.match(/^\/image\/([a-f0-9-]+)\.(jpg|jpeg|png|webp)$/i);

  if (!match) {
    return null;
  }

  const mediaId = match[1];
  let format = match[2].toLowerCase() as "jpg" | "png" | "webp";
  if (format === "jpeg") format = "jpg";

  const params = event.queryStringParameters || {};
  const width = params.w ? parseInt(params.w, 10) : undefined;
  const height = params.h ? parseInt(params.h, 10) : undefined;

  // Validate dimensions
  if (width && (width < 1 || width > 4000)) return null;
  if (height && (height < 1 || height > 4000)) return null;

  return { mediaId, format, width, height };
}

/**
 * Download base image from S3
 */
async function downloadBaseImage(
  bucketName: string,
  mediaId: string,
  format: "jpg" | "png" | "webp"
): Promise<Buffer> {
  // Try the exact format first
  const baseFormat = format === "webp" ? "jpg" : format; // webp doesn't have a base, use jpg
  const key = `processed/${mediaId}/base.${baseFormat}`;

  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      })
    );

    if (!response.Body) {
      throw new Error(`No body in S3 response for ${key}`);
    }

    const chunks: Uint8Array[] = [];
    const stream = response.Body as AsyncIterable<Uint8Array>;
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    // If jpg not found, try png
    if (format === "jpg" || format === "webp") {
      const fallbackKey = `processed/${mediaId}/base.png`;
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: fallbackKey,
        })
      );

      if (!response.Body) {
        throw new Error(`No body in S3 response for ${fallbackKey}`);
      }

      const chunks: Uint8Array[] = [];
      const stream = response.Body as AsyncIterable<Uint8Array>;
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
    throw error;
  }
}

/**
 * Resize and convert image
 */
async function processImage(
  imageBuffer: Buffer,
  format: "jpg" | "png" | "webp",
  width?: number,
  height?: number
): Promise<Buffer> {
  let transformer = sharp(imageBuffer);

  // Resize if dimensions provided
  if (width || height) {
    transformer = transformer.resize(width, height, {
      fit: "inside", // Maintain aspect ratio
      withoutEnlargement: true, // Don't upscale
    });
  }

  // Convert to output format
  switch (format) {
    case "png":
      return transformer.png({ quality: 90, compressionLevel: 6 }).toBuffer();
    case "webp":
      return transformer.webp({ quality: 85 }).toBuffer();
    case "jpg":
    default:
      return transformer.jpeg({ quality: 85, progressive: true }).toBuffer();
  }
}

/**
 * Get content type for format
 */
function getContentType(format: "jpg" | "png" | "webp"): string {
  switch (format) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "jpg":
    default:
      return "image/jpeg";
  }
}

/**
 * Resize Image Lambda
 *
 * Handles requests from CloudFront for on-demand image resizing.
 * URL pattern: /image/<media-id>.<format>?w=xxx&h=yyy
 *
 * - Fetches base image from S3 /processed/<media-id>/base.<format>
 * - Resizes according to query parameters (maintains aspect ratio)
 * - Returns resized image with appropriate cache headers
 */
export const main = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  console.log("Received request:", JSON.stringify(event, null, 2));

  const bucketName = process.env.MEDIA_BUCKET_NAME;
  if (!bucketName) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "MEDIA_BUCKET_NAME not configured" }),
    };
  }

  // Parse request
  const request = parseRequest(event);
  if (!request) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid request path or parameters" }),
    };
  }

  const { mediaId, format, width, height } = request;
  console.log(`Processing image: ${mediaId}, format: ${format}, w: ${width}, h: ${height}`);

  try {
    // Download base image from S3
    const baseImage = await downloadBaseImage(bucketName, mediaId, format);
    console.log(`Downloaded base image: ${baseImage.length} bytes`);

    // Process (resize and convert) the image
    const processedImage = await processImage(baseImage, format, width, height);
    console.log(`Processed image: ${processedImage.length} bytes`);

    // Return the image with cache headers
    return {
      statusCode: 200,
      headers: {
        "Content-Type": getContentType(format),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Image-Width": width?.toString() || "original",
        "X-Image-Height": height?.toString() || "original",
      },
      body: processedImage.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (error) {
    console.error("Error processing image:", error);

    // Check if it's a not found error
    if ((error as { name?: string }).name === "NoSuchKey") {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Image not found" }),
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to process image" }),
    };
  }
};
