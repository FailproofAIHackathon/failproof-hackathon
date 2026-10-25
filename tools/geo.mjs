// Shared, deterministic trip maths. Used by BOTH the agent's tool and the Failproof policies,
// so the agent can never disagree with the guardrail.
import fs from "node:fs";
import path from "node:path";

export const ROAD_FACTOR = 1.3; // straight-line km -> approx road km

export function loadCities(root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, "data", "cities.json"), "utf8"));
}

function haversine([lat1, lon1], [lat2, lon2]) {
  const r = (d) => (d * Math.PI) / 180, R = 6371;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function computeTrip(plan, cities) {
  const stops = plan.stops || [];
  let km = 0;
  for (let i = 1; i < stops.length; i++) km += haversine(cities[stops[i - 1]], cities[stops[i]]) * ROAD_FACTOR;
  if (plan.roundTrip) km *= 2;
  const distanceKm = Math.round(km * 10) / 10;
  const litres = distanceKm / plan.mileageKmpl;
  const totalCost = Math.round(litres * plan.fuelPricePerL * 100) / 100;
  const costPerPerson = Math.round((totalCost / (plan.travellers || 1)) * 100) / 100;
  return { distanceKm, litres: Math.round(litres * 100) / 100, totalCost, costPerPerson };
}

export function closest(name, cities) {
  const n = String(name).toLowerCase();
  return Object.keys(cities).filter((c) => !c.includes(","))
    .map((c) => [c, [...c.toLowerCase()].filter((ch, i) => n[i] === ch).length])
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
}

// ---- Actual road route from Mappls (route_adv). Used by the agent's tool AND the Failproof policy. ----
function mapplsToken(root) {
  if (process.env.MAPPLS_TOKEN || process.env.MAPPLS_API_KEY) return process.env.MAPPLS_TOKEN || process.env.MAPPLS_API_KEY;
  try {
    const m = fs.readFileSync(path.join(root, ".env"), "utf8").match(/^\s*MAPPLS_TOKEN\s*=\s*["']?([^"'\r\n]+)/m);
    return m ? m[1].trim() : "";
  } catch { return ""; }
}
const roadCache = new Map();
export async function roadKm(points, root = process.cwd()) {
  const token = mapplsToken(root);
  if (!token || points.length < 2) return null;
  const coords = points.map(([lat, lng]) => `${lng.toFixed(5)},${lat.toFixed(5)}`).join(";");
  if (roadCache.has(coords)) return roadCache.get(coords);
  const q = "overview=false&steps=false&alternatives=false";
  for (const url of [
    `https://route.mappls.com/route/direction/route_eta/driving/${coords}?access_token=${encodeURIComponent(token)}&overview=false&steps=false`,
    `https://route.mappls.com/route/direction/route_adv/driving/${coords}?access_token=${encodeURIComponent(token)}&${q}`,
    `https://apis.mappls.com/advancedmaps/v1/${encodeURIComponent(token)}/route_adv/driving/${coords}?${q}`,
  ]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      const rt = (j.routes || [])[0];
      if (rt && rt.distance) { const out = { km: Math.round(rt.distance / 100) / 10, min: Math.round((rt.duration || 0) / 60) }; roadCache.set(coords, out); return out; }
    } catch {}
  }
  return null;
}
// Same as computeTrip, but with the actual Mappls road distance when a token is available.
export async function computeTripRoad(plan, cities, root = process.cwd()) {
  const stops = plan.stops || [];
  const pts = stops.map((s) => cities[s]);
  if (plan.roundTrip && pts.length) pts.push(pts[0]);
  const road = await roadKm(pts, root);
  if (!road) return { ...computeTrip(plan, cities), source: "estimate" };
  const distanceKm = road.km, litres = distanceKm / plan.mileageKmpl;
  const totalCost = Math.round(litres * plan.fuelPricePerL * 100) / 100;
  return { distanceKm, litres: Math.round(litres * 100) / 100, totalCost,
    costPerPerson: Math.round((totalCost / (plan.travellers || 1)) * 100) / 100, driveMin: road.min, source: "mappls-road" };
}

// ---- extra data + helpers for the edge-case guardrails ----
export function loadJson(root, name) { try { return JSON.parse(fs.readFileSync(path.join(root, "data", name), "utf8")); } catch { return {}; } }
export function routeKmEst(stops, round, cities) {
  return computeTrip({ stops, roundTrip: round, mileageKmpl: 1, fuelPricePerL: 1, travellers: 1 }, cities).distanceKm;
}
// Best order of the middle stops (start and end stay fixed). Brute force for <= 7 middle stops.
export function bestOrder(stops, round, cities) {
  if (stops.length < 4) return stops;
  const first = stops[0], last = round ? null : stops[stops.length - 1];
  const mid = round ? stops.slice(1) : stops.slice(1, -1);
  if (mid.length > 7) return stops;
  let best = stops, bestKm = routeKmEst(stops, round, cities);
  const perm = (a) => a.length <= 1 ? [a] : a.flatMap((x, i) => perm([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r]));
  for (const p of perm(mid)) {
    const cand = last ? [first, ...p, last] : [first, ...p];
    const km = routeKmEst(cand, round, cities);
    if (km < bestKm - 0.5) { best = cand; bestKm = km; }
  }
  return best;
}
