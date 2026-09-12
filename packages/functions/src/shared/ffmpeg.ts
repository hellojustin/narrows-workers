/**
 * ffmpeg/ffprobe subprocess helpers for the container-image Lambdas.
 *
 * Two shapes of use:
 *   - runFfmpeg: run to completion, output goes to files. Used by the transcode.
 *   - spawnFfmpeg: caller consumes stdout as a stream. Used by the analysis,
 *     which reads decoded PCM incrementally because a 4h34m episode decodes to
 *     about 3.2 GB and cannot be buffered.
 *
 * ffmpeg writes progress and warnings to stderr, and on failure that text is the
 * only diagnostic available, so it is captured and logged rather than discarded.
 */

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

const FFMPEG_BIN = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_PATH ?? "ffprobe";

/**
 * stderr is capped so a long run cannot exhaust memory. ffmpeg emits a progress
 * line roughly twice a second, so a 4h34m transcode would otherwise accumulate
 * megabytes of text nobody reads. The head keeps the input analysis, which
 * explains stream layout, and the tail keeps the error, which is always last.
 */
const STDERR_HEAD_BYTES = 8 * 1024;
const STDERR_TAIL_BYTES = 32 * 1024;

export interface FfmpegResult {
  /** Captured stderr, truncated in the middle if the run was long. */
  stderr: string;
  elapsedMs: number;
}

export interface FfmpegOptions {
  /**
   * Hard limit on the run. Must be below the Lambda timeout so we fail with a
   * usable message instead of being killed mid-write. Use timeoutFromContext().
   */
  timeoutMs?: number;
  /** Working directory. ffmpeg resolves relative output paths against this. */
  cwd?: string;
  /**
   * Called with ffmpeg's reported progress position, in seconds of media.
   * Throttled by ffmpeg's own emission rate, roughly twice a second.
   */
  onProgress?: (mediaPositionSec: number) => void;
  /** Prefix for log lines, so concurrent runs are distinguishable. */
  label?: string;
}

export class FfmpegError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly args: string[];

  constructor(params: {
    message: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    args: string[];
  }) {
    super(params.message);
    this.name = "FfmpegError";
    this.exitCode = params.exitCode;
    this.signal = params.signal;
    this.stderr = params.stderr;
    this.args = params.args;
  }
}

export interface FfmpegProcess {
  /** Decoded output when the args write to `pipe:1`. */
  stdout: Readable;
  /** Resolves when ffmpeg exits 0, rejects with FfmpegError otherwise. */
  completion: Promise<FfmpegResult>;
  kill(): void;
}

/** Accumulates stderr keeping the head and the tail, dropping the middle. */
class StderrBuffer {
  private head = "";
  private tail = "";
  private droppedBytes = 0;

  append(chunk: string): void {
    if (this.head.length < STDERR_HEAD_BYTES) {
      const room = STDERR_HEAD_BYTES - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
      if (!chunk) return;
    }
    this.tail += chunk;
    if (this.tail.length > STDERR_TAIL_BYTES) {
      const excess = this.tail.length - STDERR_TAIL_BYTES;
      this.tail = this.tail.slice(excess);
      this.droppedBytes += excess;
    }
  }

  toString(): string {
    if (this.droppedBytes === 0) return this.head + this.tail;
    return `${this.head}\n... ${this.droppedBytes} bytes of progress output omitted ...\n${this.tail}`;
  }
}

/** ffmpeg progress lines look like: `size=  1024kB time=00:01:23.45 bitrate=...` */
const PROGRESS_TIME = /time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/;

function parseProgressSeconds(line: string): number | null {
  const match = PROGRESS_TIME.exec(line);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Spawn ffmpeg with the flags every Lambda invocation wants.
 *
 * -nostdin matters: without it ffmpeg can block waiting on a stdin it will
 * never receive, and the Lambda times out with no useful output.
 */
export function spawnFfmpeg(args: string[], opts: FfmpegOptions = {}): FfmpegProcess {
  const label = opts.label ?? "ffmpeg";
  const fullArgs = ["-nostdin", "-hide_banner", "-loglevel", "warning", "-stats", ...args];
  const startedAt = Date.now();

  console.log(`[${label}] ${FFMPEG_BIN} ${fullArgs.join(" ")}`);

  // stdio is ["ignore", "pipe", "pipe"], so stdin is null and stdout/stderr are
  // both readable streams.
  const child = spawn(FFMPEG_BIN, fullArgs, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderr = new StderrBuffer();
  let partialLine = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr.append(chunk);
    if (!opts.onProgress) return;
    partialLine += chunk;
    // ffmpeg overwrites the stats line with \r rather than emitting \n.
    const lines = partialLine.split(/[\r\n]/);
    partialLine = lines.pop() ?? "";
    for (const line of lines) {
      const seconds = parseProgressSeconds(line);
      if (seconds !== null) opts.onProgress(seconds);
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const completion = new Promise<FfmpegResult>((resolve, reject) => {
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(
        new FfmpegError({
          message: `[${label}] failed to spawn ${FFMPEG_BIN}: ${error.message}`,
          exitCode: null,
          signal: null,
          stderr: stderr.toString(),
          args: fullArgs,
        })
      );
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const elapsedMs = Date.now() - startedAt;
      const stderrText = stderr.toString();

      if (timedOut) {
        console.error(`[${label}] timed out after ${elapsedMs} ms\n${stderrText}`);
        reject(
          new FfmpegError({
            message: `[${label}] exceeded its ${opts.timeoutMs} ms budget after ${elapsedMs} ms`,
            exitCode: code,
            signal,
            stderr: stderrText,
            args: fullArgs,
          })
        );
        return;
      }

      if (code !== 0) {
        console.error(`[${label}] exited ${code} (signal ${signal}) after ${elapsedMs} ms\n${stderrText}`);
        reject(
          new FfmpegError({
            message: `[${label}] exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
            exitCode: code,
            signal,
            stderr: stderrText,
            args: fullArgs,
          })
        );
        return;
      }

      console.log(`[${label}] completed in ${elapsedMs} ms`);
      if (stderrText.trim()) console.log(`[${label}] stderr: ${stderrText}`);
      resolve({ stderr: stderrText, elapsedMs });
    });
  });

  return {
    stdout: child.stdout,
    completion,
    kill: () => child.kill("SIGKILL"),
  };
}

/**
 * Run ffmpeg to completion, discarding stdout.
 *
 * stdout is drained rather than ignored: if the args do write to pipe:1 and
 * nobody reads it, ffmpeg blocks on a full pipe buffer and never exits.
 */
export async function runFfmpeg(args: string[], opts: FfmpegOptions = {}): Promise<FfmpegResult> {
  const proc = spawnFfmpeg(args, opts);
  proc.stdout.resume();
  return proc.completion;
}

export interface ProbedAudio {
  durationSec: number;
  sampleRate: number;
  channels: number;
  codecName: string;
  /** Nominal bitrate in bits per second, absent for some variable-bitrate sources. */
  bitRate: number | null;
}

/**
 * Read audio stream properties. Accepts a local path or an HTTP URL, so this
 * works against a presigned S3 URL without downloading the file.
 */
export async function probeAudio(input: string, opts: FfmpegOptions = {}): Promise<ProbedAudio> {
  const label = opts.label ?? "ffprobe";
  const args = [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name,sample_rate,channels,bit_rate:format=duration",
    "-of",
    "json",
    input,
  ];

  const child = spawn(FFPROBE_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: string[] = [];
  child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => stderrChunks.push(c));

  const timer: ReturnType<typeof setTimeout> | undefined =
    opts.timeoutMs === undefined ? undefined : setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });

  const stderrText = stderrChunks.join("");
  if (exitCode !== 0) {
    throw new FfmpegError({
      message: `[${label}] exited with code ${exitCode}`,
      exitCode,
      signal: null,
      stderr: stderrText,
      args,
    });
  }

  const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as {
    streams?: Array<{
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
      bit_rate?: string;
    }>;
    format?: { duration?: string };
  };

  const stream = parsed.streams?.[0];
  if (!stream) {
    throw new FfmpegError({
      message: `[${label}] found no audio stream in ${input}`,
      exitCode,
      signal: null,
      stderr: stderrText,
      args,
    });
  }

  const durationSec = Number(parsed.format?.duration ?? NaN);
  if (!Number.isFinite(durationSec)) {
    throw new FfmpegError({
      message: `[${label}] could not determine duration for ${input}`,
      exitCode,
      signal: null,
      stderr: stderrText,
      args,
    });
  }

  return {
    durationSec,
    sampleRate: Number(stream.sample_rate ?? 0),
    channels: stream.channels ?? 0,
    codecName: stream.codec_name ?? "unknown",
    bitRate: stream.bit_rate ? Number(stream.bit_rate) : null,
  };
}

/**
 * Timeout that leaves the handler room to report the failure and clean up.
 *
 * Without this an over-running transcode is killed by Lambda with no log line
 * explaining why, and SQS retries it twice more for the same reason.
 */
export function timeoutFromContext(
  context: { getRemainingTimeInMillis(): number } | undefined,
  reserveMs = 30_000
): number | undefined {
  if (!context) return undefined;
  const remaining = context.getRemainingTimeInMillis();
  return Math.max(remaining - reserveMs, 1_000);
}
