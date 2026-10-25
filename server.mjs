// Yatra local demo server: serves the pages and proxies Mappls APIs.
// The Mappls token is read from .env (never committed, never sent to GitHub).
// Run:  node server.mjs   then open  http://localhost:4173/yatra-chat.html
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
function loadEnv() {
  const f = path.join(root, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();
let TOKEN = process.env.MAPPLS_TOKEN || process.env.MAPPLS_API_KEY || "";
const PORT = Number(process.env.PORT || 4173);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

async function proxy(res, url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(await r.text());
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const T = encodeURIComponent(TOKEN);
  if (u.pathname === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ mapplsToken: TOKEN })); // browser SDK needs it; served only on localhost
  }
  if (u.pathname === "/api/token" && req.method === "POST") {
    // Save the token the user typed into the page to the local .env (this machine only).
    let body = ""; for await (const c of req) body += c;
    const t = String((JSON.parse(body || "{}").token) || "").trim();
    if (!/^[A-Za-z0-9_\-.]{8,200}$/.test(t)) { res.writeHead(400); return res.end("bad token"); }
    const f = path.join(root, ".env");
    const lines = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l && !/^\s*MAPPLS_TOKEN\s*=/.test(l)) : [];
    lines.push("MAPPLS_TOKEN=" + t); fs.writeFileSync(f, lines.join("\n") + "\n");
    TOKEN = t; res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"ok":true}');
  }
  if (u.pathname === "/api/autosuggest")
    return proxy(res, `https://search.mappls.com/search/places/autosuggest/json?access_token=${T}&query=${encodeURIComponent(u.searchParams.get("query") || "")}&region=IND&tokenizeAddress&richData=true`);
  if (u.pathname === "/api/geocode")
    return proxy(res, `https://search.mappls.com/search/address/geocode?access_token=${T}&address=${encodeURIComponent(u.searchParams.get("address") || "")}&itemCount=1`);
  // static files (never serve .env or dot-folders)
  let p = decodeURIComponent(u.pathname === "/" ? "/yatra-chat.html" : u.pathname);
  if (p.split("/").some((s) => s.startsWith("."))) { res.writeHead(403); return res.end("Forbidden"); }
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Yatra demo: http://localhost:${PORT}/yatra-chat.html`);
  console.log(TOKEN ? "Mappls token loaded from .env" : "No MAPPLS_TOKEN in .env - map will use the offline fallback");
});
