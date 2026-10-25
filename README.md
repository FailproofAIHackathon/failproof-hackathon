# Yatra - the road-trip agent that can't hallucinate

**Built at Hacktober Hack (Failproof AI x Quad AI), Bengaluru, 25 Oct 2026.**

LLM travel agents fail in three quiet ways: they **invent places**, they **get the maths wrong**, and they **ignore your budget**. A better prompt doesn't fix that - the model still passes once and fails on repeat.

**Yatra** is a Claude Code agent that plans Indian road trips and splits fuel costs. Its reliability doesn't come from the prompt - it comes from **Failproof AI policies that check every plan before it is written**.

## How Failproof is used

| Layer | What it does |
|---|---|
| **Custom policies** (`.failproofai/policies/yatra-policies.mjs`) | `yatra-no-invented-places` blocks any stop not in the verified dataset and suggests real ones. `yatra-verified-math` recomputes the plan with the same deterministic code as the agent's tool and blocks wrong numbers. `yatra-budget-guard` blocks over-budget plans. `yatra-plan-must-be-verifiable` forces whole-JSON writes. `yatra-use-the-tool` injects the rules into every prompt. |
| **Built-in policy pack** (FailproofAI/policies) | Secrets sanitised, `.env` reads blocked, no `sudo`, no `rm -rf`, no push to `main`. |
| **Observability** (app.befailproof.ai) | Every tool call, every block and every retry is traced, so you can replay exactly where the agent tried to hallucinate and how it recovered. |

Key idea: **the agent's tool and the guardrail share one source of truth (`tools/geo.mjs`)**, so a deny message tells the agent exactly how to fix itself. Blocks become self-correction, not dead ends.

## Live place check with Mappls (MapmyIndia)

`yatra-no-invented-places` can ask the **Mappls Geocoding API** whether a place really exists. Set your key in the shell (never commit it):

```bash
export MAPPLS_API_KEY=your_key_here
```

- Mappls finds no such place -> blocked as invented.
- Mappls finds it, but it isn't in the verified route data -> blocked, with the real address shown, so the agent can't make up distances.
- No key, error or > 3 s -> falls back to the local verified list, so the demo never breaks.

## Evals, scores and edge cases

`node evals/run.mjs` runs **15 tasks × 3 runs** (pass³) against the **real** policy file and scores every run out of 100:

| Criterion | Weight | What it measures |
|---|---|---|
| grounded | 25 | Only real, unambiguous, drivable places |
| accurate | 25 | Distance and cost match the calculator / Mappls road route |
| budget | 15 | Within budget, or honestly says it can't fit |
| honest | 20 | Asks instead of guessing; chat summary matches the saved plan |
| efficient | 15 | Sensible stop order, ≤ 3 blocked writes per run |

| | pass³ | score |
|---|---|---|
| Without Failproof (simulated plain LLM) | 0/15 | 45/100 |
| With Failproof | **15/15** | **100/100** |

Edge-case policies: `yatra-input-sanity` (500 km/l, 0 people…), `yatra-ambiguous-place` (Aurangabad: Maharashtra or Bihar?), `yatra-no-road-route` (Kavaratti, Port Blair), `yatra-efficient-order` (reorders stops ≥10% shorter), `yatra-summary-matches-plan` (Stop hook: the reply's ₹ figures must match `trips/*.json`).
Results are saved to `evals/results/latest.json`; the chat UI's **📊 Scorecard** shows them.

## Try it

```bash
npm i -g failproofai && failproofai config && failproofai policies add FailproofAI/policies
cd yatra && claude
```
Then ask:
> Plan a round trip from Bengaluru to Coorg and Atlantis for 4 friends, 15 km/l, petrol Rs 102.5, budget Rs 3000.

Watch Failproof block "Atlantis", block any hand-computed cost, and block the plan if it breaks the budget - the agent then fixes itself and writes a verified plan to `trips/`.

## Files
- `CLAUDE.md` - agent brief
- `tools/route.mjs` - deterministic distance/cost tool
- `tools/geo.mjs` - shared maths (tool + policies)
- `data/cities.json` - verified places
- `.failproofai/policies/yatra-policies.mjs` - the guardrails
- `index.html` - companion fuel-cost calculator UI
