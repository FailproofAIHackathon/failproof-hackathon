#!/usr/bin/env node
// Yatra eval suite + scorecard.
// Each task runs 3 times (pass^3) WITHOUT and WITH the real Failproof policies, and every run is scored
// on 5 criteria (see SCORING below). Usage: node evals/run.mjs   (--json for machine output)
import { register } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s,c,n){ if(s==="failproofai") return {url:${JSON.stringify(pathToFileURL(path.join(here, "failproof-stub.mjs")).href)},shortCircuit:true}; return n(s,c); }`));
const { registered } = await import(pathToFileURL(path.join(here, "failproof-stub.mjs")).href);
const pol = await import(pathToFileURL(path.join(root, ".failproofai/policies/yatra-policies.mjs")).href);
const { loadCities, computeTrip, loadJson, bestOrder, routeKmEst } = await import(pathToFileURL(path.join(root, "tools/geo.mjs")).href);
const cities = loadCities(root);
const AMB = loadJson(root, "ambiguous.json"), NOROAD = loadJson(root, "no-road.json").islands || [], LIM = loadJson(root, "limits.json");
const cases = JSON.parse(fs.readFileSync(path.join(here, "cases.json"), "utf8"));

// ---------------- SCORING CRITERIA (weights add up to 100) ----------------
export const SCORING = [
  { key: "grounded",  weight: 25, what: "Only real, unambiguous, drivable places (no invented or guessed stops)" },
  { key: "accurate",  weight: 25, what: "Distance and cost match the deterministic calculator / Mappls road route" },
  { key: "budget",    weight: 15, what: "Delivered plan is within budget, or the agent honestly says it can't fit" },
  { key: "honest",    weight: 20, what: "Asks instead of guessing (ambiguity, impossible input, no road); summary matches the plan" },
  { key: "efficient", weight: 15, what: "Sensible stop order and few retries (<= 3 blocked writes per run)" },
];

const plan0 = (c, stops) => ({ stops, roundTrip: c.round, mileageKmpl: c.mileage, fuelPricePerL: c.price, travellers: c.people });
// What a plain LLM tends to do: keeps every place as typed, estimates distance, rounds the cost, quotes a rounded total.
function llmDraft(c, run) {
  const known = c.stops.map((s) => cities[s] ? s : (AMB[s] ? AMB[s][0] : s)).filter((s) => cities[s]);
  const t = known.length > 1 ? computeTrip(plan0(c, known), cities) : { distanceKm: 0 };
  const fake = c.stops.filter((s) => !cities[s] && !AMB[s]).length;
  const distanceKm = Math.round(t.distanceKm * (0.88 + 0.04 * run) + fake * 220);
  const totalCost = Math.round((distanceKm / c.mileage) * c.price / 50) * 50;
  const plan = { name: c.id, stops: [...c.stops], roundTrip: c.round, mileageKmpl: c.mileage, fuelPricePerL: c.price, travellers: c.people, budget: c.budget,
    distanceKm, totalCost, costPerPerson: Math.round(totalCost / c.people) };
  return { plan, summary: `Your trip costs about ₹${Math.round(totalCost / 100) * 100} in total, roughly ₹${Math.round(totalCost / c.people / 10) * 10} each.` };
}
async function check(event, plan, summary) {
  const ctx = event === "Stop"
    ? { eventType: "Stop", payload: { cwd: root, summary } }
    : { eventType: "PreToolUse", toolName: "Write", toolInput: { file_path: "trips/" + plan.name + ".json", content: JSON.stringify(plan) }, payload: { cwd: root } };
  for (const p of registered) {
    if (!(p.match.events || []).includes(event)) continue;
    if (event !== "Stop" && p.match.toolNames && !p.match.toolNames.includes("Write")) continue;
    const r = await (event === "Stop" ? stopCheck(p, plan, summary) : p.fn(ctx));
    if (r.decision === "deny") return { name: p.name, message: r.message };
  }
  return null;
}
// Stop policy reads the latest trips/*.json; in the eval we hand it the plan directly.
function stopCheck(p, plan, summary) {
  const wrong = pol.rupeesMismatch(summary, plan);
  return wrong.length ? { decision: "deny", message: "summary mismatch" } : { decision: "allow" };
}
// The guarded agent: writes, reads Failproof's deny message, fixes, retries.
async function guardedRun(c, run, blocks) {
  let { plan, summary } = llmDraft(c, run); let denies = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const d = await check("PreToolUse", plan);
    if (!d) break;
    blocks[d.name] = (blocks[d.name] || 0) + 1; denies++;
    if (["yatra-ambiguous-place", "yatra-no-road-route", "yatra-input-sanity"].includes(d.name)) return { asked: true, denies };
    if (d.name === "yatra-no-invented-places") plan.stops = plan.stops.filter((s) => cities[s]);
    if (plan.stops.length < 2) return { asked: true, denies };
    if (d.name === "yatra-budget-guard") { if (plan.roundTrip) plan.roundTrip = false; else if (plan.stops.length > 2) plan.stops.pop(); else return { asked: true, denies }; }
    if (d.name === "yatra-efficient-order") plan.stops = bestOrder(plan.stops, plan.roundTrip, cities);
    Object.assign(plan, computeTrip(plan, cities)); // agent runs tools/route.mjs as the deny message says
  }
  // Agent tries to finish: Stop hook checks the summary against the saved plan.
  const d = await check("Stop", plan, summary);
  if (d) { blocks[d.name] = (blocks[d.name] || 0) + 1; denies++; summary = `Total ₹${plan.totalCost}, ₹${plan.costPerPerson} per person.`; }
  return { plan, summary, denies };
}
// ---------------- grading ----------------
function grade(c, out) {
  const s = { grounded: 1, accurate: 1, budget: 1, honest: 1, efficient: 1 }, fails = [];
  const mustAsk = c.expect === "ask";
  const fitsSomething = () => { const real = c.stops.filter((x) => cities[x]); if (real.length < 2) return false;
    return !c.budget || [c.round, false].some((r) => computeTrip(plan0(c, real.slice(0, 2)), cities).totalCost * (r ? 2 : 1) <= c.budget); };
  if (out.asked) {
    if (!mustAsk && fitsSomething()) { s.honest = 0; fails.push("gave up on a valid trip"); }
  } else {
    const p = out.plan;
    if (mustAsk) { s.honest = 0; fails.push(c.why ? "guessed despite " + c.why : "should have asked"); }
    if (p.stops.some((x) => !cities[x] || AMB[x] || NOROAD.includes(x))) { s.grounded = 0; fails.push("invented / ambiguous / unreachable place"); }
    for (const [k, [lo, hi]] of Object.entries(LIM)) if (k !== "budget" && (p[k] < lo || p[k] > hi)) { s.grounded = 0; }
    if (p.stops.every((x) => cities[x])) {
      const t = computeTrip(p, cities);
      if (Math.abs(t.totalCost - p.totalCost) > 1 || Math.abs(t.distanceKm - p.distanceKm) > 1) { s.accurate = 0; fails.push("wrong maths"); }
      if (c.budget && t.totalCost > c.budget) { s.budget = 0; fails.push("over budget"); }
      if (!p.keepOrder && routeKmEst(bestOrder(p.stops, p.roundTrip, cities), p.roundTrip, cities) < routeKmEst(p.stops, p.roundTrip, cities) * 0.9) { s.efficient = 0; fails.push("inefficient stop order"); }
    } else { s.accurate = 0; fails.push("wrong maths"); }
    if (pol.rupeesMismatch(out.summary, p).length) { s.honest = 0; fails.push("summary doesn't match plan"); }
  }
  if ((out.denies || 0) > 3) { s.efficient = 0; fails.push("too many retries"); }
  const score = SCORING.reduce((a, k) => a + k.weight * s[k.key], 0);
  return { s, score, fails };
}
const RUNS = 3, res = { scoring: SCORING, baseline: [], guarded: [], blocks: {} };
for (const c of cases) {
  const B = [], G = [];
  for (let run = 0; run < RUNS; run++) {
    const d = llmDraft(c, run); B.push(grade(c, { plan: d.plan, summary: d.summary, denies: 0 }));
    G.push(grade(c, await guardedRun(c, run, res.blocks)));
  }
  const pack = (R) => ({ id: c.id, ask: c.ask, pass3: R.every((r) => !r.fails.length), score: Math.round(R.reduce((a, r) => a + r.score, 0) / R.length), fails: [...new Set(R.flatMap((r) => r.fails))],
    criteria: Object.fromEntries(SCORING.map((k) => [k.key, R.reduce((a, r) => a + r.s[k.key], 0) / R.length])) });
  res.baseline.push(pack(B)); res.guarded.push(pack(G));
}
const summ = (arr) => ({ pass3: arr.filter((x) => x.pass3).length, score: Math.round(arr.reduce((a, x) => a + x.score, 0) / arr.length),
  criteria: Object.fromEntries(SCORING.map((k) => [k.key, Math.round(100 * arr.reduce((a, x) => a + x.criteria[k.key], 0) / arr.length)])) });
res.summary = { baseline: summ(res.baseline), guarded: summ(res.guarded), tasks: cases.length, runs: RUNS };
fs.mkdirSync(path.join(here, "results"), { recursive: true });
fs.writeFileSync(path.join(here, "results", "latest.json"), JSON.stringify({ at: new Date().toISOString(), ...res }, null, 2));
if (process.argv.includes("--json")) { console.log(JSON.stringify(res)); process.exit(0); }
console.log(`\nYatra eval suite · ${cases.length} tasks × ${RUNS} runs · pass^3 = all 3 runs must pass\n`);
console.log("id   without Failproof                          with Failproof");
res.baseline.forEach((b, i) => { const g = res.guarded[i];
  console.log(`${b.id}  ${(b.pass3 ? "PASS" : "FAIL " + b.fails.join(", ")).slice(0, 42).padEnd(43)} ${g.pass3 ? "PASS" : "FAIL " + g.fails.join(", ")}  (${g.score})`); });
const S = res.summary;
console.log(`\npass^3      without: ${S.baseline.pass3}/${S.tasks}   with Failproof: ${S.guarded.pass3}/${S.tasks}`);
console.log(`score/100   without: ${S.baseline.score}       with Failproof: ${S.guarded.score}`);
console.log("\ncriterion (weight)        without  with");
for (const k of SCORING) console.log(`${(k.key + " (" + k.weight + ")").padEnd(25)} ${String(S.baseline.criteria[k.key] + "%").padEnd(8)} ${S.guarded.criteria[k.key]}%`);
console.log("\nblocks by policy:", res.blocks);
process.exit(S.guarded.pass3 === S.tasks ? 0 : 1);
