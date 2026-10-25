// Yatra local demo server: serves the pages and proxies Mappls APIs.
// The Mappls token is read from .env (never committed, never sent to GitHub).
// Run:  node server.mjs   then open  http://localhost:4173/yatra-chat.html
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

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

// Encoded polyline -> [[lng,lat]]; tries precision 6 then 5 and keeps the one that lands in India.
function decodePolyline(str) {
  for (const prec of [6, 5]) {
    const f = Math.pow(10, prec), out = []; let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (const k of [0, 1]) { let b, sh = 0, res = 0; do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
        const d = res & 1 ? ~(res >> 1) : res >> 1; if (k === 0) lat += d; else lng += d; }
      out.push([lng / f, lat / f]);
    }
    if (out.length && out.every(([x, y]) => x > 60 && x < 100 && y > 5 && y < 40)) return out;
  }
  return [];
}
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
  if (u.pathname.startsWith("/api/")) { res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("Access-Control-Allow-Headers", "Content-Type"); }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
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
  if (u.pathname === "/api/evals") {
    // run the pass^3 eval suite against the real Failproof policies
    return execFile(process.execPath, [path.join(root, "evals", "run.mjs"), "--json"], { cwd: root, timeout: 30000 }, (err, stdout) => {
      res.writeHead(stdout ? 200 : 500, { "Content-Type": "application/json" }); res.end(stdout || JSON.stringify({ error: String(err) }));
    });
  }
  if (u.pathname === "/api/route") {
    // Real road route from Mappls (route_adv). coords = "lng,lat;lng,lat;..."
    const coords = (u.searchParams.get("coords") || "").replace(/[^0-9.,;-]/g, "");
    const q = "geometries=geojson&overview=full&alternatives=2&steps=false";
    const urls = [
      // same Route ETA call as the "Mappls ai testing" project (polyline precision 1e5)
      `https://route.mappls.com/route/direction/route_eta/driving/${coords}?access_token=${T}&alternatives=2&geometries=polyline&overview=full&steps=false&isSort=true`,
      `https://route.mappls.com/route/direction/route_adv/driving/${coords}?access_token=${T}&${q}`,
      `https://apis.mappls.com/advancedmaps/v1/${T}/route_adv/driving/${coords}?${q}`,
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) { console.log("Mappls route " + r.status + " from " + url.split("?")[0].replace(T, "<token>")); continue; }
        const j = await r.json();
        const routes = (j.routes || []).map((rt) => ({
          km: Math.round((rt.distance || 0) / 100) / 10,
          min: Math.round((rt.duration || 0) / 60),
          coords: typeof rt.geometry === "string" ? decodePolyline(rt.geometry) : (rt.geometry && rt.geometry.coordinates) || [],
        })).filter((x) => x.km > 0);
        if (routes.length) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ routes })); }
      } catch (e) { console.log("Mappls route error: " + e.message); }
    }
    res.writeHead(502, { "Content-Type": "application/json" }); return res.end('{"error":"no route from Mappls"}');
  }
  if (u.pathname === "/api/trace" && req.method === "POST") {
    // Send this chat turn to Failproof as a custom-agent session (python failproofai-sdk -> local daemon -> cloud).
    let body = ""; for await (const c of req) body += c;
    const child = execFile("python3", [path.join(root, "tools", "fp_log.py")], { cwd: root, timeout: 20000 }, (err, out, errOut) => {
      if (err) console.log("Failproof trace not sent: " + String(errOut || err.message).split("\n").slice(-2).join(" "));
      else console.log("Failproof trace sent: " + String(out).trim());
    });
    child.stdin.end(body);
    res.writeHead(202, { "Content-Type": "application/json" }); return res.end('{"queued":true}');
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
}).on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.log(`Port ${PORT} is busy - an older Yatra server is still running.\nStop it with:  pkill -f "node server.mjs"   then run  node server.mjs  again.`); process.exit(1); }
  throw e;
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Yatra demo: http://localhost:${PORT}/yatra-chat.html`);
  console.log(TOKEN ? "Mappls token loaded from .env" : "No MAPPLS_TOKEN in .env - map will use the offline fallback");
});
