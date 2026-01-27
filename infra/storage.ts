/**
 * Storage configuration
 *
 * Uses existing S3 bucket specified via MEDIA_BUCKET_NAME environment variable
 */

export const mediaBucketName = process.env.MEDIA_BUCKET_NAME ?? "";

if (!mediaBucketName) {
  console.warn("Warning: MEDIA_BUCKET_NAME environment variable not set");
}
