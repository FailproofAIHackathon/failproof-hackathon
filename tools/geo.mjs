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
  return Object.keys(cities)
    .map((c) => [c, [...c.toLowerCase()].filter((ch, i) => n[i] === ch).length])
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
}
