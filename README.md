# ⛽ Trip Fuel Cost Calculator

A small, dependency-free web app that estimates how much fuel a road trip needs and what it will cost — and splits that cost fairly between everyone travelling.

## What it does

Enter:

- **Distance** (km, one way)
- **Vehicle mileage** (km per litre)
- **Fuel price** (₹ per litre)
- **Number of travellers**
- **Round trip** checkbox (doubles the distance)

And instantly see:

- **Litres of fuel needed**
- **Total fuel cost** (₹)
- **Cost per person** (₹)

Results update live as you type, with validation for empty or invalid values. The layout is responsive (works on phones) and follows your system's light/dark theme.

**Formula**

```
total distance = distance × (round trip ? 2 : 1)
litres needed  = total distance ÷ mileage
total cost     = litres needed × fuel price
per person     = total cost ÷ travellers
```

## How to run

No build step, no server, no API keys.

1. Clone or download this repository.
2. Open `index.html` in any modern web browser (double-click it).

That's it — everything (HTML, CSS and JavaScript) lives in that single file.

## Built by an AI coding agent, guarded by Failproof AI

This app was written by an AI coding agent rather than by hand. The agent's work was **monitored and guarded by [Failproof AI](https://github.com/FailproofAIHackathon)** throughout the session:

- **Every tool call is recorded.** Failproof AI hooks into the agent's tool-use lifecycle, so each file read, file write and shell command the agent attempts is logged — giving a full, auditable trail of how the code was produced.
- **Policies block dangerous actions before they run.** Guardrail policies intercept risky operations and stop them, for example:
  - reading secrets such as `.env` files,
  - pushing directly to the `main` branch,
  - running commands with `sudo`,
  - destructive deletes like `rm -rf`.

The result: the speed of an autonomous coding agent, with a human-auditable record and hard safety limits on what it is allowed to do.
