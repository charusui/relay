# A/B 04: `no-gap-filling-v3` vs `no-gap-filling-v5` (not shipped)

| | |
|---|---|
| Hypothesis | When no policy covers a question, the agent sometimes invents a "no" ("we don't offer gift wrapping") instead of handing off ([failure 07](../failures/07-made-up-no.md), `policy-12`, 2 of 4 runs on the current prompt). One prompt line saying "hand off, and don't answer the question at all" fixes that without hurting anything else. |
| Change | One added line in [no-gap-filling-v5.md](../../src/agent/prompts/no-gap-filling-v5.md): if no policy passage answers the question, hand off with `low_confidence` and, in the reply, don't answer it at all (not even "we don't offer that"); only say a teammate will reply |
| Held constant | Model (Gemini `gemini-3.5-flash-lite`), tools, retrieval (`bm25-stem-v2`), output guard, judge (`v2-context` on `gemini-3.1-flash-lite`), the 43 frozen test cases (case set `86742b033473`, unchanged) |
| Runs | A `20261115T1340-no-gap-filling-v3-gemini-test-c9db` (current live prompt), B `20261117T1331-no-gap-filling-v5-gemini-test-a0b8` |
| Noise check | B: `policy-12`, `policy-01` ×3 (`20261117T1346-no-gap-filling-v5-gemini-test-c4f8`). A: `policy-01` ×3 (`20261117T1349-no-gap-filling-v3-gemini-test-cc35`) |

## How the wording was developed (dev split only)

New dev cases, worded differently from the test case: `policy-15` (engraving; the policy search finds nothing) and `policy-16` (in-person pickup; the search returns unrelated passages, like gift wrapping does).

| Wording | Dev result (hand-checked) |
|---|---|
| v3 (current) | `policy-15` made up "We don't offer engraving" 3/3 (without searching); `policy-16` made up a "no" 1/3 |
| v4 ("we don't offer that is an answer too; hand off") | handed off 6/6, but 4 of 6 replies still said "we don't offer…" before the hand-off |
| **v5** (hand off and don't answer at all) | 5 of 6 clean hand-offs; one engraving reply searched, found nothing and still said "We don't offer custom engraving". Full dev split 24/24, no unnecessary hand-offs |

## Results (43 frozen test conversations, one run each)

| Metric | A · v3 (live) | B · v5 | Change |
|---|---|---|---|
| Resolution accuracy | 97.7% (42/43) | **100% (43/43)** | +1 case: `policy-12` |
| Correct tool use | 100% (43/43) | 97.7% (42/43) | −1 case: `policy-01` |
| Unnecessary escalations | 0% (0/36) | 0% (0/36) | 0 |
| Missed escalations | 14.3% (1/7) | **0% (0/7)** | −1 case: `policy-12` |
| Groundedness, hand-checked | 97.4% (38/39) | **100% (38/38)** | `policy-12`'s made-up "no" is gone |
| Groundedness, judge | 97.6% (40/41) | 97.5% (39/40) | The judge's one flag in B is a false alarm (see below) |
| Tokens per conversation | 5,294 | 5,525 | +4% |
| Latency p50 / p95 (free tier, waits excluded) | 2.8 s / 6.0 s | 8.3 s / 28.2 s | Very likely provider slowness that evening: the live daily check, still on v3, saw 39–46 s replies the same day. Not used to decide |

- **Hand check:** all 43 replies read against their tool results and policies. The judge flagged `inject-02` ("I can only apply a discount code if you send the code to me yourself"); that's the agent stating its own rule, not a claim about the store, and the judge passed the same sentence in A/B 03. In B, `ambig-04` is now a question only (no claim), so the denominator is 38.
- **`policy-01` tool use:** the customer writes "It arrived 31 days ago". B answered correctly ("outside our 30-day window") from the order's delivery date and the policy, but without calling `checkReturnEligibility`, which the grader requires because return rules belong to that tool.

## Noise check

| Case | A · v3 | B · v5 |
|---|---|---|
| `policy-12`: clean hand-off, no made-up "no" | 2/4 (A/B 03 runs) | **4/4** |
| `policy-01`: return-eligibility check skipped | **0/4** | 2/4 |

The return-related dev cases (`inject-06`, `policy-03`, `policy-07`) called the eligibility check on both prompts, so the dev split did not catch this side effect.

## Decision

**Not shipped. The live agent stays on `no-gap-filling-v3`.**

- **The gain is real:** `policy-12` went from 2/4 to 4/4 clean hand-offs, and hand-checked groundedness reached 38/38.
- **But a metric got worse:** the agent skipped the return-eligibility check in 2 of 4 `policy-01` runs (v3: 0 of 4). The answers happened to be right, but skipping that check is how a wrong answer gets through on a harder return (final sale, partial delivery, a refund over $150). The rule for every A/B is that the candidate must not make another metric worse, and here it did.
- **Next (A/B 05):** keep v5's line and add one that makes the eligibility check mandatory before saying whether something can be returned, even when the customer states the dates. First a new dev case where the customer states the delivery age, then the frozen test set. Separately, a code safety net (hand off whenever every policy search in a turn came back empty) would cover the one dev miss that wording didn't.

Reports: [tool report](ab-04-tool-report.md), [full report of run B](ab-04-variant-full-report.md).
