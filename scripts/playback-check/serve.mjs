import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = process.env.PLAYBACK_ROOT ?? "/tmp/playback";
const PORT = Number(process.env.PLAYBACK_PORT ?? 877);
const TYPES = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".aac": "audio/aac",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const filePath = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(filePath)] ?? "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
      "Content-Length": body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
