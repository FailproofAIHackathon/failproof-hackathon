# Yatra - hosted evaluations for app.befailproof.ai

Create each one in **Analyze → eval authoring → new eval**, paste the code, **test** it on your recent
sessions, then **deploy**. Use **"score sessions you already have"** to score today's runs too.
Payload field names depend on the harness, so these checks search the whole event payload text.

---

## 1. `yatra_self_correction` (result type: score)

Did Failproof catch a bad plan and did the agent recover with a verified one?

```python
EvalResult(
    score=Score(
        1.0 if (len([e for e in session.events if "yatra-" in str(e.payload) and "deny" in str(e.payload).lower()]) > 0
                and len([e for e in session.events if "trips/" in str(e.payload) and "deny" not in str(e.payload).lower()]) > 0)
        else (0.6 if len([e for e in session.events if "trips/" in str(e.payload)]) > 0 else 0.0)
    ),
    metrics={
        "yatra_blocks": Metric(len([e for e in session.events if "yatra-" in str(e.payload) and "deny" in str(e.payload).lower()]), unit="blocks"),
        "plan_writes": Metric(len([e for e in session.events if "trips/" in str(e.payload)]), unit="writes"),
    },
    reasoning="1 = a Yatra policy blocked a bad plan and a verified plan was written afterwards; 0.6 = plan written with no block needed; 0 = no plan.",
)
```

## 2. `yatra_used_calculator` (result type: score)

Share of plan writes that came after the deterministic tool `tools/route.mjs` was run.

```python
EvalResult(
    score=Score(
        min(1.0, len([e for e in session.events if "route.mjs" in str(e.payload)])
            / max(1, len([e for e in session.events if "trips/" in str(e.payload)])))
    ),
    metrics={"calculator_calls": Metric(len([e for e in session.events if "route.mjs" in str(e.payload)]), unit="calls")},
    reasoning="Yatra must never compute cost itself: every plan should be preceded by a route.mjs call.",
)
```

## 3. `tool_success_rate` (result type: score)

```python
EvalResult(
    score=Score(
        1.0 - min(1.0, session.count("error") / max(1, session.event_count / 10))
    ),
    metrics={"errors": Metric(session.count("error"), unit="errors"), "events": Metric(session.event_count, unit="events")},
    reasoning="Fewer errors per event is better.",
)
```

## Sentiment
Your sessions show "scoring off". Turn on sentiment scoring in **settings → sentiment** to score the human messages too.

## 4. `yatra_quality_score` (result type: score) - the overall monitoring score

Same 5 criteria as `evals/run.mjs`, measured on live sessions from what the policies decided.

```python
EvalResult(
    score=Score(round((
        25 * (0 if len([e for e in session.events if "yatra-no-invented-places" in str(e.payload) and "deny" in str(e.payload).lower()]) > 0 and len([e for e in session.events if "trips/" in str(e.payload)]) == 0 else 1)
      + 25 * (1 if len([e for e in session.events if "route.mjs" in str(e.payload)]) > 0 else 0)
      + 15 * (0 if len([e for e in session.events if "yatra-budget-guard" in str(e.payload) and "deny" in str(e.payload).lower()]) > 3 else 1)
      + 20 * (0 if len([e for e in session.events if "yatra-summary-matches-plan" in str(e.payload) and "deny" in str(e.payload).lower()]) > 1 else 1)
      + 15 * (1 if len([e for e in session.events if "yatra-" in str(e.payload) and "deny" in str(e.payload).lower()]) <= 3 else 0)
    ) / 100, 2)),
    metrics={
        "blocks_total": Metric(len([e for e in session.events if "yatra-" in str(e.payload) and "deny" in str(e.payload).lower()]), unit="blocks"),
        "asked_user": Metric(len([e for e in session.events if any(k in str(e.payload) for k in ["yatra-ambiguous-place", "yatra-no-road-route", "yatra-input-sanity"])]), unit="asks"),
    },
    reasoning="Weighted: grounded 25, accurate 25, budget 15, honest 20, efficient 15.",
)
```

**Monitor it:** add a dashboard tile for the average `yatra_quality_score` per day and an alert when it drops below 0.8, or when `blocks_total` > 3 in one session (the agent is looping).
