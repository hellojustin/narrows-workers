/**
 * Lambda layers.
 *
 * The ffmpeg layer carries statically linked ffmpeg and ffprobe binaries for the
 * transcode and analysis functions. Lambda mounts a layer at `/opt`, so the
 * binaries land at `/opt/bin/ffmpeg` and `/opt/bin/ffprobe`, and `/opt/bin` is
 * already on PATH for the Node runtimes.
 *
 * Build the artefact before deploying:
 *
 *   npm run build:ffmpeg-layer
 *
 * The zip is uploaded through S3 rather than inline. Inline upload is capped at
 * 50 MB and the artefact is 48.8 MB, so an inline layer would break on the next
 * ffmpeg release rather than on a change of ours.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { mediaBucketName } from "./storage";

export const FFMPEG_ARCHITECTURE = "arm64";

/**
 * arm64 over x86_64 for two measured reasons: Lambda bills arm64 at
 * $0.0000133334 per GB-second against $0.0000166667, a 20% saving; and the
 * static build is 97 MB unpacked against 152 MB, which leaves far more room
 * under the 250 MB limit.
 *
 * The encoder may produce different bytes from an x86 build because of
 * floating-point differences. That does not matter here: the requirement is the
 * same bitrate, segment length and audio encoding, not identical bytes.
 */
// process.cwd() rather than $cli.paths.root: sst runs from the directory holding
// sst.config.ts, and $cli is marked internal in the platform types.
const layerZipPath = path.join(process.cwd(), ".artifacts", `ffmpeg-layer-${FFMPEG_ARCHITECTURE}.zip`);

if (!existsSync(layerZipPath)) {
  throw new Error(
    [
      `ffmpeg layer artefact missing at ${layerZipPath}.`,
      "Run `npm run build:ffmpeg-layer` before deploying.",
    ].join(" ")
  );
}

const layerHash = createHash("sha256").update(readFileSync(layerZipPath)).digest("base64");

/**
 * Deploy artefacts live alongside media rather than in a bucket of their own.
 * The prefix is not referenced by any playlist or API response, so it is not
 * reachable through the CDN in practice.
 */
const layerObject = new aws.s3.BucketObjectv2("FfmpegLayerArchive", {
  bucket: mediaBucketName,
  key: `deploy/layers/ffmpeg-${FFMPEG_ARCHITECTURE}-${layerHash
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 16)}.zip`,
  source: new $util.asset.FileAsset(layerZipPath),
  contentType: "application/zip",
});

const ffmpegLayer = new aws.lambda.LayerVersion("FfmpegLayer", {
  layerName: `narrows-${$app.stage}-ffmpeg`,
  description: `Static ffmpeg and ffprobe (${FFMPEG_ARCHITECTURE})`,
  s3Bucket: layerObject.bucket,
  s3Key: layerObject.key,
  sourceCodeHash: layerHash,
  compatibleRuntimes: ["nodejs20.x"],
  compatibleArchitectures: [FFMPEG_ARCHITECTURE],
});

/**
 * Exported as the ARN rather than the resource: the inferred LayerVersion type
 * cannot be named outside the SST platform's own node_modules, so exporting the
 * object is not portable across a `tsc --noEmit`.
 */
export const ffmpegLayerArn: $util.Output<string> = ffmpegLayer.arn;

/** Environment the functions need so the shared runner finds the binaries. */
export const ffmpegEnv = {
  FFMPEG_PATH: "/opt/bin/ffmpeg",
  FFPROBE_PATH: "/opt/bin/ffprobe",
};
