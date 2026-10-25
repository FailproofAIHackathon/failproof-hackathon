// Yatra guardrails - custom Failproof AI policies (auto-loaded from .failproofai/policies/).
// They run BEFORE the agent writes a trip plan, so a bad plan never reaches the user.
import { customPolicies, deny, allow, instruct } from "failproofai";
import { loadCities, computeTrip, closest } from "../../tools/geo.mjs";

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

// 2. No hallucinated places: every stop must exist in data/cities.json.
customPolicies.add({
  name: "yatra-no-invented-places",
  match: { events: ["PreToolUse"], toolNames: ["Write"] },
  fn: async (ctx) => {
    const plan = isPlan(ctx) && parse(ctx); if (!plan) return allow();
    const cities = loadCities(root(ctx));
    const bad = (plan.stops || []).filter((s) => !cities[s]);
    if (!bad.length) return allow();
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
    const t = computeTrip(plan, cities);
    const off = ["distanceKm", "totalCost", "costPerPerson"].filter((k) => Math.abs(Number(plan[k]) - t[k]) > 1);
    if (!off.length) return allow();
    return deny(`Blocked: ${off.join(", ")} do not match the verified calculation (${JSON.stringify(t)}). Never compute costs yourself - run: node tools/route.mjs --stops ${plan.stops.join(",")} --mileage ${plan.mileageKmpl} --price ${plan.fuelPricePerL} --people ${plan.travellers}${plan.roundTrip ? " --round" : ""}`);
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

// 5. Nudge: remind the agent of its tool whenever a session starts working on trips.
customPolicies.add({
  name: "yatra-use-the-tool",
  match: { events: ["UserPromptSubmit"] },
  fn: async () => instruct("Yatra rule: compute every distance and cost with `node tools/route.mjs`, and write plans to trips/<name>.json. Guardrails will block unverified places, wrong maths and over-budget plans."),
});
