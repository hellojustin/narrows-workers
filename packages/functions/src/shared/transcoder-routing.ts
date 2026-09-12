/**
 * Chooses which transcoder handles an episode, so MediaConvert can be replaced by
 * ffmpeg one series at a time with a rollback available at every step.
 *
 * Routing is keyed on the series, not the episode. Keying on the episode would
 * put some episodes of a series on each path, which makes a report of "this show
 * sounds wrong" impossible to act on and mixes segment containers within one
 * series for no benefit.
 *
 * Configuration, all optional:
 *
 *   TRANSCODER                    "mediaconvert" (default) or "ffmpeg"
 *   FFMPEG_TRANSCODE_SERIES_IDS   comma-separated series ids always on ffmpeg
 *   FFMPEG_TRANSCODE_PERCENT      0-100, share of remaining series on ffmpeg
 *   FFMPEG_TRANSCODE_SHADOW       "true" to also run ffmpeg into a scratch prefix
 *
 * The default is MediaConvert, so an unconfigured stage keeps existing behaviour.
 */

import { createHash } from "node:crypto";

export type Transcoder = "mediaconvert" | "ffmpeg";

export interface RoutingConfig {
  defaultTranscoder: Transcoder;
  seriesIds: Set<string>;
  percent: number;
  shadow: boolean;
}

export interface RoutingDecision {
  transcoder: Transcoder;
  /** Run ffmpeg into a scratch prefix alongside MediaConvert, comparing later. */
  shadow: boolean;
  /** Why this episode went where it did, for the log line. */
  reason: string;
}

function parsePercent(raw: string | undefined): number {
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function readRoutingConfig(env: NodeJS.ProcessEnv = process.env): RoutingConfig {
  const configured = (env.TRANSCODER ?? "").trim().toLowerCase();
  return {
    defaultTranscoder: configured === "ffmpeg" ? "ffmpeg" : "mediaconvert",
    seriesIds: new Set(
      (env.FFMPEG_TRANSCODE_SERIES_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    ),
    percent: parsePercent(env.FFMPEG_TRANSCODE_PERCENT),
    shadow: (env.FFMPEG_TRANSCODE_SHADOW ?? "").trim().toLowerCase() === "true",
  };
}

/**
 * Stable 0-99 bucket for a series.
 *
 * A hash rather than a counter so the same series lands in the same bucket on
 * every invocation and in every process, which is what makes raising the
 * percentage additive: series already on ffmpeg stay there.
 */
export function seriesBucket(seriesId: string): number {
  const digest = createHash("sha256").update(seriesId).digest();
  return digest.readUInt32BE(0) % 100;
}

export function routeTranscoder(
  params: { seriesId?: string | null },
  config: RoutingConfig
): RoutingDecision {
  const { seriesId } = params;

  if (config.defaultTranscoder === "ffmpeg") {
    return { transcoder: "ffmpeg", shadow: false, reason: "TRANSCODER=ffmpeg" };
  }

  if (seriesId && config.seriesIds.has(seriesId)) {
    return { transcoder: "ffmpeg", shadow: false, reason: "series in FFMPEG_TRANSCODE_SERIES_IDS" };
  }

  if (seriesId && config.percent > 0) {
    const bucket = seriesBucket(seriesId);
    if (bucket < config.percent) {
      return {
        transcoder: "ffmpeg",
        shadow: false,
        reason: `series bucket ${bucket} < FFMPEG_TRANSCODE_PERCENT ${config.percent}`,
      };
    }
  }

  return {
    transcoder: "mediaconvert",
    // Shadow only applies to episodes still on MediaConvert. Shadowing one
    // already on ffmpeg would transcode it twice for no comparison.
    shadow: config.shadow,
    reason: config.shadow ? "mediaconvert with ffmpeg shadow" : "default",
  };
}
