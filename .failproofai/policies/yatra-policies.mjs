// Yatra guardrails - custom Failproof AI policies (auto-loaded from .failproofai/policies/).
// They run BEFORE the agent writes a trip plan, so a bad plan never reaches the user.
import { customPolicies, deny, allow, instruct } from "failproofai";
import fs from "node:fs";
import path from "node:path";
import { loadCities, computeTrip, computeTripRoad, closest, loadJson, bestOrder, routeKmEst } from "../../tools/geo.mjs";

// Optional live check with the Mappls (MapmyIndia) Geocoding API.
// Set the key yourself in the shell:  export MAPPLS_API_KEY=xxxx
// Endpoint can be overridden with MAPPLS_GEOCODE_URL ({q} and {key} are replaced).
// If the key is missing, the call fails or takes > 3 s, Yatra falls back to the local list.
async function mapplsLookup(place) {
  const key = process.env.MAPPLS_API_KEY;
  if (!key) return null;
  const tpl = process.env.MAPPLS_GEOCODE_URL ||
    "https://search.mappls.com/search/address/geocode?address={q}&itemCount=1&access_token={key}";
  try {
    const res = await fetch(tpl.replace("{q}", encodeURIComponent(place + ", India")).replace("{key}", key),
      { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const j = await res.json();
    const hit = (j.copResults && (Array.isArray(j.copResults) ? j.copResults[0] : j.copResults)) || (j.results && j.results[0]);
    if (!hit) return { found: false };
    const addr = hit.formattedAddress || hit.formatted_address || hit.placeName || "";
    const city = String(hit.city || hit.district || hit.locality || hit.placeName || addr).toLowerCase();
    // Count it as real only if Mappls' match actually names the place asked for.
    return { found: city.includes(place.toLowerCase()) || addr.toLowerCase().includes(place.toLowerCase()), addr };
  } catch { return null; }
}

const isPlan = (ctx) => /trips[\\/][^\\/]+\.json$/.test(String(ctx.toolInput?.file_path || ""));
const root = (ctx) => String(ctx.payload?.cwd || process.cwd());
const parse = (ctx) => { try { return JSON.parse(String(ctx.toolInput?.content || "")); } catch { return null; } };

// 1. Plans must be written whole, as valid JSON, so they can be verified.
customPolicies.add({
  name: "yatra-plan-must-be-verifiable",
  match: { events: ["PreToolUse"], toolNames: ["Write", "Edit", "MultiEdit"] },
  fn: async (ctx) => {
    if (!isPlan(ctx)) return allow();
    if (ctx.toolName !== "Write") return deny("Trip plans must be rewritten in full with Write so Yatra's guardrails can verify them.");
    if (!parse(ctx)) return deny("Trip plan is not valid JSON. Write it as JSON with stops, mileageKmpl, fuelPricePerL, travellers, budget, distanceKm, totalCost, costPerPerson.");
    return allow();
  },
});

// 1b. Input sanity: block impossible numbers before anything else.
customPolicies.add({
  name: "yatra-input-sanity",
  match: { events: ["PreToolUse"], toolNames: ["Write"] },
  fn: async (ctx) => {
    const plan = isPlan(ctx) && parse(ctx); if (!plan) return allow();
    const L = loadJson(root(ctx), "limits.json"), bad = [];
    for (const [k, [lo, hi]] of Object.entries(L)) {
      const v = Number(plan[k] ?? (k === "budget" ? 0 : NaN));
      if (!Number.isFinite(v) || v < lo || v > hi) bad.push(`${k}=${plan[k]} (expected ${lo}-${hi})`);
    }
    if (plan.travellers && !Number.isInteger(Number(plan.travellers))) bad.push("travellers must be a whole number");
    if (!bad.length) return allow();
    return deny(`Blocked: impossible input - ${bad.join("; ")}. Do not plan with these numbers. Ask the user to confirm the correct values.`);
  },
});

// 1c. Ambiguous places: never guess which Aurangabad / Bilaspur the user meant.
customPolicies.add({
  name: "yatra-ambiguous-place",
  match: { events: ["PreToolUse"], toolNames: ["Write"] },
  fn: async (ctx) => {
    const plan = isPlan(ctx) && parse(ctx); if (!plan) return allow();
    const A = loadJson(root(ctx), "ambiguous.json");
    const amb = (plan.stops || []).filter((s) => A[s]);
    if (!amb.length) return allow();
    return deny(`Blocked: "${amb[0]}" is ambiguous - it could be ${A[amb[0]].join(" or ")}. Ask the user which one they mean, then use the full name.`);
  },
});

// 1d. No road route: islands can't be driven to.
customPolicies.add({
  name: "yatra-no-road-route",
  match: { events: ["PreToolUse"], toolNames: ["Write"] },
  fn: async (ctx) => {
    const plan = isPlan(ctx) && parse(ctx); if (!plan) return allow();
    const N = loadJson(root(ctx), "no-road.json");
    const isl = (plan.stops || []).filter((s) => (N.islands || []).includes(s));
    if (!isl.length) return allow();
    return deny(`Blocked: there is no road route to ${isl.join(", ")}. ${N.note || ""} Tell the user a road trip is not possible and suggest flying or a ferry.`);
  },
});

// 2. No hallucinated places: every stop must exist in data/cities.json.
customPolicies.add({
  name: "yatra-no-invented-places",
  match: { events: ["PreToolUse"], toolNames: ["Write"] },
  fn: async (ctx) => {
    const plan = isPlan(ctx) && parse(ctx); if (!plan) return allow();
    const cities = loadCities(root(ctx));
    const bad = (plan.stops || []).filter((s) => !cities[s]);
    if (!bad.length) return allow();
    const live = await mapplsLookup(bad[0]);
    if (live && live.found)
      return deny(`Blocked: ${bad[0]} is a real place (verified by Mappls: ${live.addr}) but it is not in Yatra's route dataset yet, so distances can't be verified. Choose a verified place instead, e.g. ${closest(bad[0], cities).join(", ")}, and tell the user.`);
    if (live && !live.found)
      return deny(`Blocked: Mappls found no place called ${bad.join(", ")} in India. Do not invent places. Verified options: ${closest(bad[0], cities).join(", ")}.`);
    return deny(`Blocked: ${bad.join(", ")} not found in the verified places list. Did you mean: ${closest(bad[0], cities).join(", ")}? Only use places from data/cities.json and tell the user which place you could not verify.`);
  },
});

// 3. No LLM arithmetic: cost figures must match the deterministic calculator.
customPolicies.add({
  name: "yatra-verified-math",
  match: { events: ["PreToolUse"], toolNames: ["Write"] },
  fn: async (ctx) => {
    const plan = isPlan(ctx) && parse(ctx); if (!plan) return allow();
    const cities = loadCities(root(ctx));
    if ((plan.stops || []).some((s) => !cities[s])) return allow(); // handled by policy 2
    const t = await computeTripRoad(plan, cities, root(ctx)); // actual Mappls road distance when MAPPLS_TOKEN is set
    const off = ["distanceKm", "totalCost", "costPerPerson"].filter((k) => Math.abs(Number(plan[k]) - t[k]) > 1);
    if (!off.length) return allow();
    return deny(`Blocked: ${off.join(", ")} do not match the verified ${t.source === "mappls-road" ? "Mappls road route" : "calculation"} (${JSON.stringify(t)}). Never compute costs yourself - run: node tools/route.mjs --stops ${plan.stops.join(",")} --mileage ${plan.mileageKmpl} --price ${plan.fuelPricePerL} --people ${plan.travellers}${plan.roundTrip ? " --round" : ""}`);
  },
});

// 4. Budget guard: never hand the user a plan they cannot afford.
customPolicies.add({
  name: "yatra-budget-guard",
  match: { events: ["PreToolUse"], toolNames: ["Write"] },
  fn: async (ctx) => {
    const plan = isPlan(ctx) && parse(ctx); if (!plan || !plan.budget) return allow();
    if (Number(plan.totalCost) <= Number(plan.budget)) return allow();
    return deny(`Blocked: plan costs Rs ${plan.totalCost}, over the Rs ${plan.budget} budget. Drop or swap a stop (re-run tools/route.mjs) until it fits, or tell the user it cannot fit.`);
  },
});

// 4b. Stop order: start and end stay fixed; reorder the middle stops if that saves >= 10%.
customPolicies.add({
  name: "yatra-efficient-order",
  match: { events: ["PreToolUse"], toolNames: ["Write"] },
  fn: async (ctx) => {
    const plan = isPlan(ctx) && parse(ctx); if (!plan || plan.keepOrder) return allow();
    const cities = loadCities(root(ctx));
    if ((plan.stops || []).some((s) => !cities[s])) return allow();
    const best = bestOrder(plan.stops, plan.roundTrip, cities);
    const now = routeKmEst(plan.stops, plan.roundTrip, cities), opt = routeKmEst(best, plan.roundTrip, cities);
    if (opt >= now * 0.9) return allow();
    return deny(`Blocked: stop order ${plan.stops.join(" → ")} is inefficient (~${Math.round(now)} km). ${best.join(" → ")} is ~${Math.round(opt)} km. Re-run tools/route.mjs with that order, or set "keepOrder": true only if the user explicitly asked for this order.`);
  },
});

// 4c. The chat summary must match the saved plan (checked when the agent tries to finish).
function latestPlan(dir) {
  try {
    const f = fs.readdirSync(path.join(dir, "trips")).filter((x) => x.endsWith(".json"))
      .map((x) => path.join(dir, "trips", x)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    return f ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
  } catch { return null; }
}
function lastAssistantText(payload) {
  if (payload?.last_assistant_message) return String(payload.last_assistant_message);
  try {
    const lines = fs.readFileSync(String(payload?.transcript_path), "utf8").trim().split("\n").reverse();
    for (const l of lines) { const j = JSON.parse(l); if (j.type === "assistant") return JSON.stringify(j.message?.content ?? ""); }
  } catch {}
  return "";
}
export function rupeesMismatch(text, plan) {
  const nums = [...String(text).matchAll(/(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/gi)].map((m) => Number(m[1].replace(/,/g, "")));
  const ok = [plan.totalCost, plan.costPerPerson, plan.budget, plan.fuelPricePerL].filter((v) => v != null).map(Number);
  return nums.filter((n) => !ok.some((v) => Math.abs(v - n) <= 1));
}
customPolicies.add({
  name: "yatra-summary-matches-plan",
  match: { events: ["Stop"] },
  fn: async (ctx) => {
    const plan = latestPlan(root(ctx)); if (!plan) return allow();
    const text = ctx.payload?.summary ?? lastAssistantText(ctx.payload);
    const wrong = rupeesMismatch(text, plan);
    if (!wrong.length) return allow();
    return deny(`Your reply quotes ₹${wrong.join(", ₹")} but the saved plan says total ₹${plan.totalCost}, per person ₹${plan.costPerPerson}. Restate the summary using the exact numbers from the plan file.`);
  },
});

// 5. Nudge: remind the agent of its tool whenever a session starts working on trips.
customPolicies.add({
  name: "yatra-use-the-tool",
  match: { events: ["UserPromptSubmit"] },
  fn: async () => instruct("Yatra rule: compute every distance and cost with `node tools/route.mjs`, and write plans to trips/<name>.json. Guardrails will block unverified places, wrong maths and over-budget plans."),
});
