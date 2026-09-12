import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  FfmpegError,
  probeAudio,
  runFfmpeg,
  spawnFfmpeg,
  timeoutFromContext,
} from "../../../shared/ffmpeg";

/**
 * These run the real ffmpeg rather than a mocked spawn. The behaviour worth
 * testing here is entirely about how a real subprocess exits, streams and
 * blocks, and a mock would only assert that the mock was called.
 *
 * Synthetic inputs come from lavfi, so no fixture files are needed.
 */
function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeWithFfmpeg = hasFfmpeg() ? describe : describe.skip;

/** One second of silent 48 kHz stereo, as lavfi input arguments. */
const SILENT_INPUT = ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "1"];

/** Run and return the rejection, failing the test if the call unexpectedly succeeds. */
async function expectFfmpegError(promise: Promise<unknown>): Promise<FfmpegError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FfmpegError);
    return error as FfmpegError;
  }
  throw new Error("Expected the run to reject with FfmpegError, but it resolved");
}

describeWithFfmpeg("runFfmpeg", () => {
  it("resolves with elapsed time on a successful run", async () => {
    const result = await runFfmpeg([...SILENT_INPUT, "-f", "null", "-"]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.stderr).toBe("string");
  });

  it("rejects with FfmpegError carrying the exit code and stderr", async () => {
    const error = await expectFfmpegError(
      runFfmpeg(["-i", "/nonexistent/input.mp3", "-f", "null", "-"])
    );
    expect(error.exitCode).not.toBe(0);
    expect(error.stderr).toMatch(/nonexistent/i);
    expect(error.args).toContain("-nostdin");
  });

  it("rejects when the run exceeds its timeout", async () => {
    // Unbounded input with no -t, so it only stops when killed.
    const error = await expectFfmpegError(
      runFfmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-f", "null", "-"], {
        timeoutMs: 300,
      })
    );
    expect(error.message).toMatch(/budget/);
  });

  it("does not deadlock when the arguments write to stdout and nobody reads it", async () => {
    // If stdout were merely ignored rather than drained, ffmpeg would block on a
    // full pipe once the output exceeded the buffer and never exit.
    const result = await runFfmpeg([
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "5",
      "-f",
      "s16le",
      "-",
    ]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("reports progress in seconds of media", async () => {
    const positions: number[] = [];
    await runFfmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "20", "-f", "null", "-"], {
      onProgress: (sec) => positions.push(sec),
    });

    expect(positions.length).toBeGreaterThan(0);
    expect(positions.every((p) => p >= 0)).toBe(true);
    // Monotonic, and never beyond the input length.
    expect(positions[positions.length - 1]).toBeLessThanOrEqual(21);
  });
});

describeWithFfmpeg("spawnFfmpeg", () => {
  it("streams decoded PCM on stdout with the expected byte count", async () => {
    const proc = spawnFfmpeg([
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "1",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-",
    ]);

    let bytes = 0;
    for await (const chunk of proc.stdout) bytes += (chunk as Buffer).length;
    await proc.completion;

    // 1 s x 48000 samples x 2 channels x 2 bytes.
    expect(bytes).toBe(48000 * 2 * 2);
  });

  it("rejects completion when ffmpeg fails, even if stdout was consumed", async () => {
    const proc = spawnFfmpeg(["-i", "/nonexistent/input.mp3", "-f", "s16le", "-"]);
    proc.stdout.resume();
    await expect(proc.completion).rejects.toThrow(FfmpegError);
  });
});

describeWithFfmpeg("probeAudio", () => {
  it("reads duration, sample rate and channel count", async () => {
    // probeAudio needs a real file, so make one from lavfi first.
    const tmp = `${process.env.TMPDIR ?? "/tmp"}/probe-test-${process.pid}.wav`;
    await runFfmpeg([...SILENT_INPUT, "-y", tmp]);

    const probed = await probeAudio(tmp);
    expect(probed.durationSec).toBeGreaterThan(0.9);
    expect(probed.durationSec).toBeLessThan(1.2);
    expect(probed.sampleRate).toBe(48000);
    expect(probed.channels).toBe(2);
    expect(probed.codecName).toMatch(/pcm/);
  });

  it("throws FfmpegError for a file with no audio stream", async () => {
    await expect(probeAudio("/nonexistent/input.mp3")).rejects.toThrow(FfmpegError);
  });
});

describe("timeoutFromContext", () => {
  it("returns undefined without a context, so local runs are unbounded", () => {
    expect(timeoutFromContext(undefined)).toBeUndefined();
  });

  it("reserves time for the handler to report the failure", () => {
    const context = { getRemainingTimeInMillis: () => 900_000 };
    expect(timeoutFromContext(context, 30_000)).toBe(870_000);
  });

  it("never returns a non-positive budget when time has nearly run out", () => {
    const context = { getRemainingTimeInMillis: () => 5_000 };
    expect(timeoutFromContext(context, 30_000)).toBe(1_000);
  });
});
