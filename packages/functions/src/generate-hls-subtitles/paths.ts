/**
 * S3 key helpers for HLS subtitle generation.
 */

export function transcriptJsonKey(audioMediaId: string): string {
  return `processed/${audioMediaId}/transcript.json`;
}

export function hlsPrefix(audioMediaId: string): string {
  return `processed/${audioMediaId}/hls/`;
}

export function masterManifestKey(audioMediaId: string): string {
  return `${hlsPrefix(audioMediaId)}${audioMediaId}.m3u8`;
}

export function audioPlaylistKey(audioMediaId: string): string {
  return `${hlsPrefix(audioMediaId)}${audioMediaId}_audio.m3u8`;
}

export function subtitlePlaylistKey(audioMediaId: string): string {
  return `${hlsPrefix(audioMediaId)}transcript.m3u8`;
}

export function subtitleSegmentKey(audioMediaId: string, filename: string): string {
  return `${hlsPrefix(audioMediaId)}${filename}`;
}
