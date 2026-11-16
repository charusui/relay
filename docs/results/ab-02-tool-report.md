# A/B: policy-before-handoff vs state-tool-outcome

Comparing: Prompt/flow variants, same model. 43 cases, split `test`.

| | A · baseline | B · candidate |
|---|---|---|
| Run | `20261114T0948-policy-before-handoff-gemini-test-d904` | `20261115T1012-state-tool-outcome-gemini-test-bcb9` |
| Variant | policy-before-handoff | state-tool-outcome |
| Model | gemini: gemini-3.5-flash-lite | gemini: gemini-3.5-flash-lite |

## Metrics

| Metric | A · baseline | B · candidate | Change |
|---|---|---|---|
| Resolution accuracy | 97.7% (42/43) | 100% (43/43) | +2.3 pts |
| Resolution, agent alone | 97.7% (42/43) | 100% (43/43) | +2.3 pts |
| Correct tool use | 97.7% (42/43) | 97.7% (42/43) | +0.0 pts |
| Unnecessary escalations | 0% (0/36) | 0% (0/36) | +0.0 pts |
| Missed escalations | 0% (0/7) | 0% (0/7) | +0.0 pts |
| Groundedness | 97.5% (39/40) | 100% (42/42) | +2.5 pts |
| Tokens per conversation | 5205 | 5374 | +169 (+3%) |
| Paid-equivalent cost / conversation | n/a | n/a | |
| Latency p95 (waits excluded) | 18.99 s | 11.45 s | -7.54s (-40%) |

## Decision

Rule: B ships only if it beats A on the same eval set without making another metric worse.

**No clear difference.** B fixed 1 and broke 0 (net +1), within run-to-run noise (±2 cases). Don't ship on this alone; repeat the runs (`--repeat`) or look at the per-case flips.

## Paired flips (resolution)

- **Fixed by B (1):** happy-06
- **Broken by B (0):** none

## By category

| Category | A | B |
|---|---|---|
| Happy path | 87.5% (7/8) | 100% (8/8) |
| Angry customer | 100% (6/6) | 100% (6/6) |
| Ambiguous request | 100% (6/6) | 100% (6/6) |
| Prompt injection | 100% (7/7) | 100% (7/7) |
| Order does not exist | 100% (6/6) | 100% (6/6) |
| Policy edge | 100% (10/10) | 100% (10/10) |

Full reports: `reports/20261114T0948-policy-before-handoff-gemini-test-d904.md`, `reports/20261115T1012-state-tool-outcome-gemini-test-bcb9.md`.