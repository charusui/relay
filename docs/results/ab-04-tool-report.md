# A/B: no-gap-filling-v3 vs no-gap-filling-v5

Comparing: Prompt/flow variants, same model. 43 cases, split `test`.

| | A · baseline | B · candidate |
|---|---|---|
| Run | `20261115T1340-no-gap-filling-v3-gemini-test-c9db` | `20261117T1331-no-gap-filling-v5-gemini-test-a0b8` |
| Variant | no-gap-filling-v3 | no-gap-filling-v5 |
| Model | gemini: gemini-3.5-flash-lite | gemini: gemini-3.5-flash-lite |

## Metrics

| Metric | A · baseline | B · candidate | Change |
|---|---|---|---|
| Resolution accuracy | 97.7% (42/43) | 100% (43/43) | +2.3 pts |
| Resolution, agent alone | 97.7% (42/43) | 100% (43/43) | +2.3 pts |
| Correct tool use | 100% (43/43) | 97.7% (42/43) | -2.3 pts |
| Unnecessary escalations | 0% (0/36) | 0% (0/36) | +0.0 pts |
| Missed escalations | 14.3% (1/7) | 0% (0/7) | -14.3 pts |
| Groundedness | 97.6% (40/41) | 97.5% (39/40) | -0.1 pts |
| Tokens per conversation | 5294 | 5525 | +231 (+4%) |
| Paid-equivalent cost / conversation | n/a | n/a | |
| Latency p95 (waits excluded) | 5.98 s | 28.20 s | +22.23s (+372%) |

## Decision

Rule: B ships only if it beats A on the same eval set without making another metric worse.

**No clear difference.** B fixed 1 and broke 0 (net +1), within run-to-run noise (±2 cases). Don't ship on this alone; repeat the runs (`--repeat`) or look at the per-case flips.

## Paired flips (resolution)

- **Fixed by B (1):** policy-12
- **Broken by B (0):** none

## By category

| Category | A | B |
|---|---|---|
| Happy path | 100% (8/8) | 100% (8/8) |
| Angry customer | 100% (6/6) | 100% (6/6) |
| Ambiguous request | 100% (6/6) | 100% (6/6) |
| Prompt injection | 100% (7/7) | 100% (7/7) |
| Order does not exist | 100% (6/6) | 100% (6/6) |
| Policy edge | 90% (9/10) | 100% (10/10) |

Full reports: `reports/20261115T1340-no-gap-filling-v3-gemini-test-c9db.md`, `reports/20261117T1331-no-gap-filling-v5-gemini-test-a0b8.md`.