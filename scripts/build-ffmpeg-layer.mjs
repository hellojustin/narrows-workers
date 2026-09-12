#!/usr/bin/env node
/**
 * Build the ffmpeg Lambda layer.
 *
 * Downloads a statically linked ffmpeg/ffprobe, verifies it against a recorded
 * SHA-256, and zips it into the layout Lambda expects: binaries under `bin/`,
 * which Lambda mounts at `/opt/bin` and puts on PATH.
 *
 * Run before `sst deploy`. Output is cached, so repeated deploys do not
 * re-download.
 *
 *   node scripts/build-ffmpeg-layer.mjs [--arch arm64|amd64] [--force]
 *
 * Why a layer rather than a container image: the binaries are statically linked
 * with no PT_INTERP and no PT_DYNAMIC, so they run on Lambda's Amazon Linux 2023
 * unchanged. arm64 comes to 97 MB unpacked against the 250 MB limit. A container
 * image would work too, but it means a slower cold start, an ECR repository, and
 * a Docker build in the deploy path, and SST 3.3 only supports container images
 * for Python functions.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat, readFile, writeFile, chmod, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const run = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * Pinned by digest, not by version, because johnvansickle.com serves the current
 * release from a stable "release" URL that changes contents in place. A mismatch
 * fails the build rather than silently shipping a different encoder than the one
 * the output specification was written against.
 *
 * To adopt a new build: run with --force, read the reported digest and version,
 * re-run the verification harness, then update these values in the same commit.
 */
const BUILDS = {
  arm64: {
    url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz",
    sha256: "f4149bb2b0784e30e99bdda85471c9b5930d3402014e934a5098b41d0f7201b1",
    ffmpegVersion: "7.0.2",
  },
  amd64: {
    url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
    sha256: "abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67",
    ffmpegVersion: "7.0.2",
  },
};

const args = process.argv.slice(2);
const arch = args.includes("--arch") ? args[args.indexOf("--arch") + 1] : "arm64";
const force = args.includes("--force");

const build = BUILDS[arch];
if (!build) {
  console.error(`Unknown arch "${arch}". Expected one of: ${Object.keys(BUILDS).join(", ")}`);
  process.exit(1);
}

const artifactsDir = path.join(repoRoot, ".artifacts");
const tarballPath = path.join(artifactsDir, `ffmpeg-${arch}.tar.xz`);
const stagingDir = path.join(artifactsDir, `ffmpeg-${arch}-staging`);
const zipPath = path.join(artifactsDir, `ffmpeg-layer-${arch}.zip`);

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function download(url, destination) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

/**
 * The ELF headers are the whole reason a layer works here, so the build asserts
 * them rather than trusting the upstream description. A dynamically linked build
 * would load on some hosts and fail on Lambda, which is the worst way to find out.
 */
async function assertStaticElf(binary) {
  const buffer = await readFile(binary);
  if (buffer.readUInt32BE(0) !== 0x7f454c46) {
    throw new Error(`${binary} is not an ELF binary`);
  }

  const programHeaderOffset = Number(buffer.readBigUInt64LE(0x20));
  const entrySize = buffer.readUInt16LE(0x36);
  const entryCount = buffer.readUInt16LE(0x38);

  const PT_DYNAMIC = 2;
  const PT_INTERP = 3;

  for (let i = 0; i < entryCount; i++) {
    const type = buffer.readUInt32LE(programHeaderOffset + i * entrySize);
    if (type === PT_INTERP) {
      throw new Error(`${binary} requires a dynamic loader, so it is not a static build`);
    }
    if (type === PT_DYNAMIC) {
      throw new Error(`${binary} has a PT_DYNAMIC segment, so it links shared libraries`);
    }
  }
}

async function main() {
  await mkdir(artifactsDir, { recursive: true });

  if (force || !(await exists(tarballPath))) {
    await download(build.url, tarballPath);
  } else {
    console.log(`Reusing cached ${path.relative(repoRoot, tarballPath)}`);
  }

  const digest = await sha256(tarballPath);
  if (digest !== build.sha256) {
    console.error(
      [
        `Digest mismatch for ${arch}.`,
        `  expected ${build.sha256}`,
        `  actual   ${digest}`,
        "",
        "Upstream publishes the current release at a stable URL and replaces it in",
        "place, so this means the build changed. Verify the new build with the",
        "output verification harness, then update BUILDS in this script.",
      ].join("\n")
    );
    process.exit(1);
  }
  console.log(`Digest verified: ${digest}`);

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(path.join(stagingDir, "bin"), { recursive: true });

  const extractDir = path.join(artifactsDir, `ffmpeg-${arch}-extract`);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await run("tar", ["-xJf", tarballPath, "-C", extractDir, "--strip-components=1"]);

  for (const binary of ["ffmpeg", "ffprobe"]) {
    const source = path.join(extractDir, binary);
    await assertStaticElf(source);
    const target = path.join(stagingDir, "bin", binary);
    await copyFile(source, target);
    await chmod(target, 0o755);
    const { size } = await stat(target);
    console.log(`  bin/${binary}  ${(size / 1048576).toFixed(1)} MB  static ELF verified`);
  }

  // Record what went into the layer so a deployed Lambda can be traced back to a build.
  await writeFile(
    path.join(stagingDir, "bin", "BUILD_INFO.txt"),
    [
      `ffmpeg version: ${build.ffmpegVersion}`,
      `architecture:   ${arch}`,
      `source:         ${build.url}`,
      `sha256:         ${build.sha256}`,
      `built:          ${new Date().toISOString()}`,
      "",
    ].join("\n")
  );

  await rm(zipPath, { force: true });
  // -X drops extended attributes, which keeps the archive byte-stable between
  // machines so a rebuild does not look like a change to the deploy.
  await run("zip", ["-q", "-9", "-X", "-r", zipPath, "bin"], { cwd: stagingDir });
  await rm(extractDir, { recursive: true, force: true });

  const { size } = await stat(zipPath);
  console.log(
    `\nWrote ${path.relative(repoRoot, zipPath)} (${(size / 1048576).toFixed(1)} MB zipped)`
  );
  console.log(`Layer digest: ${await sha256(zipPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
