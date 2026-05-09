import { describe, it, expect } from "vitest";
import { getFileExtension, getMimeType } from "@/download-image/handler";

describe("getFileExtension", () => {
  it("extracts jpg from URL", () => {
    expect(getFileExtension("https://example.com/cover.jpg", "image/jpeg")).toBe("jpg");
  });

  it("normalises jpeg to jpg", () => {
    expect(getFileExtension("https://example.com/cover.jpeg", "image/jpeg")).toBe("jpg");
  });

  it("extracts png from URL", () => {
    expect(getFileExtension("https://example.com/cover.png", "image/png")).toBe("png");
  });

  it("extracts webp from URL", () => {
    expect(getFileExtension("https://example.com/cover.webp", "image/webp")).toBe("webp");
  });

  it("falls back to content type when URL has no image extension", () => {
    expect(getFileExtension("https://example.com/cover", "image/png")).toBe("png");
    expect(getFileExtension("https://example.com/cover", "image/webp")).toBe("webp");
  });

  it("falls back to jpg for unknown content types", () => {
    expect(getFileExtension("https://example.com/cover", "image/unknown")).toBe("jpg");
  });

  it("handles malformed URLs gracefully and uses content type", () => {
    expect(getFileExtension("not-a-url", "image/png")).toBe("png");
  });
});

describe("getMimeType", () => {
  it("returns correct mime types for known extensions", () => {
    expect(getMimeType("jpg")).toBe("image/jpeg");
    expect(getMimeType("jpeg")).toBe("image/jpeg");
    expect(getMimeType("png")).toBe("image/png");
    expect(getMimeType("gif")).toBe("image/gif");
    expect(getMimeType("webp")).toBe("image/webp");
    expect(getMimeType("svg")).toBe("image/svg+xml");
  });

  it("falls back to image/jpeg for unknown extensions", () => {
    expect(getMimeType("bmp")).toBe("image/jpeg");
    expect(getMimeType("unknown")).toBe("image/jpeg");
  });
});
