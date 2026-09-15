import { describe, it, expect } from "vitest";
import {
  parseDuration,
  getItunesImageHref,
  looksLikeImageUrl,
  pickBestImageUrl,
  extractOwner,
  extractCategories,
  isRssParseError,
  enclosureFromRssItem,
} from "@/fetch-rss/handler";
import { rssParser } from "@/shared/rss-parser";
import { POND_BOT_USER_AGENT } from "@/shared/pond-bot-user-agent";

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

describe("isRssParseError", () => {
  it("returns true for sax/xml parse errors", () => {
    expect(
      isRssParseError(new Error("Attribute without value\nLine: 6196\nColumn: 1\nChar: 8"))
    ).toBe(true);
    expect(
      isRssParseError(
        new Error("Forward-slash in opening tag not followed by >\nLine: 5088\nColumn: 92\nChar: u")
      )
    ).toBe(true);
  });

  it("returns false for network and generic errors", () => {
    expect(isRssParseError(new Error("fetch failed"))).toBe(false);
    expect(isRssParseError(new Error("Episode sync failed (500)"))).toBe(false);
    expect(isRssParseError("not an error")).toBe(false);
  });
});

const PREFIXED_ENCLOSURE =
  "https://dts.podtrac.com/redirect.mp3/pdst.fm/e/cdn.example.com/ep1.mp3?src=rss&t=1&token=a%2Fb";

function enclosureFeedXml(url: string): string {
  const escaped = url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Test</title>
    <item>
      <title>Episode</title>
      <guid>guid-1</guid>
      <enclosure url="${escaped}" type="audio/mpeg" length="28800000"/>
    </item>
  </channel>
</rss>`;
}

describe("enclosure URL fidelity", () => {
  it("keeps a Podtrac prefix and query string byte-identical through parse", async () => {
    const feed = await rssParser.parseString(enclosureFeedXml(PREFIXED_ENCLOSURE));
    const fromParser = feed.items[0]?.enclosure?.url;
    const fromMapper = enclosureFromRssItem(feed.items[0] ?? {});

    expect(fromParser).toBe(PREFIXED_ENCLOSURE);
    expect(fromMapper.enclosureUrl).toBe(PREFIXED_ENCLOSURE);
    expect(fromMapper.enclosureUrl).toContain("dts.podtrac.com");
    expect(fromMapper.enclosureUrl).toContain("pdst.fm");
    expect(fromMapper.enclosureUrl).toContain("?src=rss&t=1&token=a%2Fb");
    expect(fromMapper.enclosureType).toBe("audio/mpeg");
    expect(fromMapper.enclosureLength).toBe(28800000);
  });

  it("does not resolve, unwrap, or strip the enclosure", async () => {
    const feed = await rssParser.parseString(enclosureFeedXml(PREFIXED_ENCLOSURE));
    const url = enclosureFromRssItem(feed.items[0] ?? {}).enclosureUrl;

    expect(url).not.toBe("https://cdn.example.com/ep1.mp3");
    expect(url).not.toMatch(/^https:\/\/cdn\.example\.com\//);
  });

  it("passes a missing enclosure through as undefined", () => {
    expect(enclosureFromRssItem({})).toEqual({
      enclosureUrl: undefined,
      enclosureType: undefined,
      enclosureLength: undefined,
    });
  });
});

describe("PondBot user agent on feed fetches", () => {
  it("configures rss-parser so parseURL identifies as PondBot", () => {
    const headers = (
      rssParser as unknown as { options: { headers: Record<string, string> } }
    ).options.headers;

    expect(headers["User-Agent"]).toBe(POND_BOT_USER_AGENT);
    expect(POND_BOT_USER_AGENT).toBe("PondBot/1.0 (+https://pondaudio.app)");
    expect(POND_BOT_USER_AGENT).toMatch(/^PondBot\//);
    expect(POND_BOT_USER_AGENT).not.toMatch(/^Pond\//);
  });
});
