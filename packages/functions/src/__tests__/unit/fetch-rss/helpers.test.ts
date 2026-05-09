import { describe, it, expect } from "vitest";
import {
  parseDuration,
  getItunesImageHref,
  looksLikeImageUrl,
  pickBestImageUrl,
  extractOwner,
  extractCategories,
} from "@/fetch-rss/handler";

describe("parseDuration", () => {
  it("returns null for undefined", () => {
    expect(parseDuration(undefined)).toBeNull();
  });

  it("parses plain seconds", () => {
    expect(parseDuration("3600")).toBe(3600);
    expect(parseDuration("0")).toBe(0);
  });

  it("parses MM:SS", () => {
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("0:45")).toBe(45);
  });

  it("parses HH:MM:SS", () => {
    expect(parseDuration("1:02:03")).toBe(3723);
    expect(parseDuration("0:00:00")).toBe(0);
  });

  it("returns null for empty string", () => {
    expect(parseDuration("")).toBeNull();
  });
});

describe("getItunesImageHref", () => {
  it("returns undefined for null/non-objects", () => {
    expect(getItunesImageHref(null)).toBeUndefined();
    expect(getItunesImageHref("string")).toBeUndefined();
    expect(getItunesImageHref(undefined)).toBeUndefined();
  });

  it("extracts href from $ attribute (xml2js format)", () => {
    expect(getItunesImageHref({ $: { href: "https://example.com/img.jpg" } })).toBe(
      "https://example.com/img.jpg"
    );
  });

  it("extracts href from direct property", () => {
    expect(getItunesImageHref({ href: "https://example.com/img.jpg" })).toBe(
      "https://example.com/img.jpg"
    );
  });

  it("prefers $ href over direct href", () => {
    expect(
      getItunesImageHref({ $: { href: "https://a.com/a.jpg" }, href: "https://b.com/b.jpg" })
    ).toBe("https://a.com/a.jpg");
  });
});

describe("looksLikeImageUrl", () => {
  it("returns true for URLs with image-looking paths", () => {
    expect(looksLikeImageUrl("https://example.com/artwork/cover.jpg")).toBe(true);
    expect(looksLikeImageUrl("https://cdn.example.com/img/abc123")).toBe(true);
  });

  it("returns false for URLs ending in web extensions", () => {
    expect(looksLikeImageUrl("https://example.com/page.html")).toBe(false);
    expect(looksLikeImageUrl("https://example.com/podcast.php")).toBe(false);
  });

  it("returns false for directory-like URLs (trailing slash)", () => {
    expect(looksLikeImageUrl("https://example.com/images/")).toBe(false);
  });

  it("returns false for invalid URLs", () => {
    expect(looksLikeImageUrl("not a url")).toBe(false);
  });
});

describe("pickBestImageUrl", () => {
  it("prefers itunes image when it looks like a real image URL", () => {
    const result = pickBestImageUrl(
      { $: { href: "https://cdn.example.com/cover.jpg" } },
      "https://example.com/feed-image"
    );
    expect(result).toBe("https://cdn.example.com/cover.jpg");
  });

  it("falls back to RSS image when itunes image looks like a webpage", () => {
    const result = pickBestImageUrl(
      { $: { href: "https://example.com/show.html" } },
      "https://cdn.example.com/cover.jpg"
    );
    expect(result).toBe("https://cdn.example.com/cover.jpg");
  });

  it("returns undefined when both are absent", () => {
    expect(pickBestImageUrl(null, undefined)).toBeUndefined();
  });

  it("returns RSS image when itunes image is null", () => {
    expect(pickBestImageUrl(null, "https://cdn.example.com/img.jpg")).toBe(
      "https://cdn.example.com/img.jpg"
    );
  });
});

describe("extractOwner", () => {
  it("returns empty object for non-objects", () => {
    expect(extractOwner(null)).toEqual({});
    expect(extractOwner(undefined)).toEqual({});
    expect(extractOwner("string")).toEqual({});
  });

  it("extracts name and email from arrays (rss-parser format)", () => {
    const result = extractOwner({
      "itunes:name": ["John Doe"],
      "itunes:email": ["john@example.com"],
    });
    expect(result).toEqual({ name: "John Doe", email: "john@example.com" });
  });

  it("extracts name and email from string values", () => {
    const result = extractOwner({
      "itunes:name": "Jane Smith",
      "itunes:email": "jane@example.com",
    });
    expect(result).toEqual({ name: "Jane Smith", email: "jane@example.com" });
  });

  it("returns partial result when only name is present", () => {
    const result = extractOwner({ "itunes:name": "John Doe" });
    expect(result.name).toBe("John Doe");
    expect(result.email).toBeUndefined();
  });
});

describe("extractCategories", () => {
  it("returns empty array for undefined", () => {
    expect(extractCategories(undefined)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(extractCategories([])).toEqual([]);
  });

  it("extracts string categories", () => {
    expect(extractCategories(["Technology", "Science"])).toEqual(["Technology", "Science"]);
  });

  it("extracts categories from object with $ text attribute", () => {
    const cats = [{ $: { text: "Technology" } }];
    expect(extractCategories(cats)).toEqual(["Technology"]);
  });

  it("extracts nested subcategories", () => {
    const cats = [
      {
        $: { text: "Technology" },
        "itunes:category": [{ $: { text: "Software" } }],
      },
    ];
    expect(extractCategories(cats)).toEqual(["Technology", "Software"]);
  });
});
