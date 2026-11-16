# A/B: baseline vs policy-before-handoff

Comparing: Prompt/flow variants, same model. 43 cases, split `test`.

| | A · baseline | B · candidate |
|---|---|---|
| Run | `20261114T0824-baseline-gemini-test-4728` | `20261114T0913-policy-before-handoff-gemini-test-69b3` |
| Variant | baseline | policy-before-handoff |
| Model | gemini: gemini-3.5-flash-lite | gemini: gemini-3.5-flash-lite |

## Metrics

| Metric | A · baseline | B · candidate | Change |
|---|---|---|---|
| Resolution accuracy | 97.7% (42/43) | 97.7% (42/43) | +0.0 pts |
| Resolution, agent alone | 97.7% (42/43) | 97.7% (42/43) | +0.0 pts |
| Correct tool use | 97.7% (42/43) | 97.7% (42/43) | +0.0 pts |
| Unnecessary escalations | 2.8% (1/36) | 0% (0/36) | -2.8 pts |
| Missed escalations | 0% (0/7) | 0% (0/7) | +0.0 pts |
| Groundedness | 97.6% (40/41) | 100% (40/40) | +2.4 pts |
| Tokens per conversation | 4849 | 5120 | +271 (+6%) |
| Paid-equivalent cost / conversation | n/a | n/a | |
| Latency p95 (waits excluded) | 5.86 s | 6.65 s | +0.80s (+14%) |

## Decision

Rule: B ships only if it beats A on the same eval set without making another metric worse.

**No clear difference.** B fixed 1 and broke 1 (net +0), within run-to-run noise (±2 cases). Don't ship on this alone; repeat the runs (`--repeat`) or look at the per-case flips.

## Paired flips (resolution)

- **Fixed by B (1):** ambig-01
- **Broken by B (1):** happy-06

## By category

| Category | A | B |
|---|---|---|
| Happy path | 100% (8/8) | 87.5% (7/8) |
| Angry customer | 100% (6/6) | 100% (6/6) |
| Ambiguous request | 83.3% (5/6) | 100% (6/6) |
| Prompt injection | 100% (7/7) | 100% (7/7) |
| Order does not exist | 100% (6/6) | 100% (6/6) |
| Policy edge | 100% (10/10) | 100% (10/10) |

Full reports: `reports/20261114T0824-baseline-gemini-test-4728.md`, `reports/20261114T0913-policy-before-handoff-gemini-test-69b3.md`.