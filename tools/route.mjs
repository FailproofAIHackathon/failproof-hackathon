#!/usr/bin/env node
// Agent tool: node tools/route.mjs --stops Bengaluru,Mysuru,Coorg --mileage 15 --price 102.5 --people 4 [--round]
import { loadCities, computeTripRoad } from "./geo.mjs";
const a = process.argv.slice(2), get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const cities = loadCities();
const plan = {
  stops: get("--stops", "").split(",").map((s) => s.trim()).filter(Boolean),
  mileageKmpl: Number(get("--mileage", 15)), fuelPricePerL: Number(get("--price", 102.5)),
  travellers: Number(get("--people", 1)), roundTrip: a.includes("--round"),
};
const unknown = plan.stops.filter((s) => !cities[s]);
if (unknown.length) { console.log(JSON.stringify({ error: `Unknown places: ${unknown.join(", ")}`, known: Object.keys(cities) })); process.exit(1); }
console.log(JSON.stringify({ ...plan, ...(await computeTripRoad(plan, cities)) }, null, 2));
