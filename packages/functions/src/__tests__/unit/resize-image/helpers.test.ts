import { describe, it, expect } from "vitest";
import { parseRequest, getContentType } from "@/resize-image/handler";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

function makeEvent(rawPath: string, qs: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    rawPath,
    queryStringParameters: qs,
  } as unknown as APIGatewayProxyEventV2;
}

describe("parseRequest", () => {
  it("parses a valid jpg request", () => {
    const result = parseRequest(makeEvent("/image/abc123.jpg"));
    expect(result).toMatchObject({ mediaId: "abc123", format: "jpg" });
  });

  it("parses a valid png request", () => {
    const result = parseRequest(makeEvent("/image/abc123.png"));
    expect(result).toMatchObject({ mediaId: "abc123", format: "png" });
  });

  it("normalises jpeg to jpg", () => {
    const result = parseRequest(makeEvent("/image/abc123.jpeg"));
    expect(result?.format).toBe("jpg");
  });

  it("parses width and height query params", () => {
    const result = parseRequest(makeEvent("/image/abc123.jpg", { w: "400", h: "300" }));
    expect(result?.width).toBe(400);
    expect(result?.height).toBe(300);
  });

  it("returns null for invalid path", () => {
    expect(parseRequest(makeEvent("/not-an-image"))).toBeNull();
    expect(parseRequest(makeEvent("/image/abc.txt"))).toBeNull();
  });

  it("returns null when width is out of range", () => {
    expect(parseRequest(makeEvent("/image/abc123.jpg", { w: "5000" }))).toBeNull();
    expect(parseRequest(makeEvent("/image/abc123.jpg", { w: "4001" }))).toBeNull();
  });

  it("returns null when height is out of range", () => {
    expect(parseRequest(makeEvent("/image/abc123.jpg", { h: "5000" }))).toBeNull();
  });

  it("allows UUIDs with hyphens as media IDs", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = parseRequest(makeEvent(`/image/${uuid}.jpg`));
    expect(result?.mediaId).toBe(uuid);
  });
});

describe("getContentType", () => {
  it("returns image/png for png", () => {
    expect(getContentType("png")).toBe("image/png");
  });

  it("returns image/webp for webp", () => {
    expect(getContentType("webp")).toBe("image/webp");
  });

  it("returns image/jpeg for jpg", () => {
    expect(getContentType("jpg")).toBe("image/jpeg");
  });
});
