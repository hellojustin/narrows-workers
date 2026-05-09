import { describe, it, expect } from "vitest";
import { getFileExtension } from "@/download-audio/handler";

describe("getFileExtension", () => {
  it("extracts extension from URL path", () => {
    expect(getFileExtension("https://example.com/audio/episode.mp3", "audio/mpeg")).toBe("mp3");
    expect(getFileExtension("https://example.com/audio/episode.m4a", "audio/mp4")).toBe("m4a");
    expect(getFileExtension("https://example.com/audio/episode.wav", "audio/wav")).toBe("wav");
  });

  it("falls back to content type when URL has no recognised extension", () => {
    expect(getFileExtension("https://example.com/audio/episode", "audio/mpeg")).toBe("mp3");
    expect(getFileExtension("https://example.com/audio/episode", "audio/mp4")).toBe("m4a");
    expect(getFileExtension("https://example.com/audio/episode", "audio/ogg")).toBe("ogg");
  });

  it("falls back to mp3 for unknown content types", () => {
    expect(getFileExtension("https://example.com/audio/episode", "audio/unknown")).toBe("mp3");
  });

  it("ignores non-audio URL extensions and uses content type", () => {
    expect(getFileExtension("https://example.com/audio/episode.php", "audio/mpeg")).toBe("mp3");
  });

  it("handles URLs with query strings", () => {
    const url = "https://example.com/audio/episode.mp3?token=abc&expires=123";
    expect(getFileExtension(url, "audio/mpeg")).toBe("mp3");
  });
});
