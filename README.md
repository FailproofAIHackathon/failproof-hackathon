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
