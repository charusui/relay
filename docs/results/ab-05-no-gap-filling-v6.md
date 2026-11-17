# A/B 05: `no-gap-filling-v3` vs `no-gap-filling-v6` (shipped)

| | |
|---|---|
| Hypothesis | A/B 04's hand-off line fixes the made-up "no" ([failure 07](../failures/07-made-up-no.md)), but on its own it led the agent to skip the return-eligibility check when the customer states the dates. Adding one line that makes the check mandatory keeps the fix without that side effect. |
| Change | [no-gap-filling-v6.md](../../src/agent/prompts/no-gap-filling-v6.md) is v5 plus one line: before telling a customer whether an item can be returned, call `checkReturnEligibility`, even if the customer says when it arrived or the dates look obvious; never work out eligibility yourself |
| Held constant | Model (Gemini `gemini-3.5-flash-lite`), tools, retrieval (`bm25-stem-v2`), output guard, judge (`v2-context` on `gemini-3.1-flash-lite`), the 43 frozen test cases (case set `86742b033473`, unchanged) |
| Runs | A `20261115T1340-no-gap-filling-v3-gemini-test-c9db` (live prompt until now), B `20261118T0104-no-gap-filling-v6-gemini-test-51ec` |
| Noise check | B: `policy-01` ×3 and `policy-12` ×3 (`20261118T0113-no-gap-filling-v6-gemini-test-5e91`) |

## How the wording was developed (dev split only)

A/B 04's side effect showed up only on the test case `policy-01` ("It arrived 31 days ago"), so three new dev cases were written first, each with the customer stating the timing:

| Dev case | What makes it hard | v5 | v3 (live) | **v6** |
|---|---|---|---|---|
| `policy-17` | "like 5 days ago", but the item is final sale (only the check knows) | called the check 3/3 | not run | **3/3** |
| `policy-18` | "arrived last week", but the record says delivered Sept 15 | called the check 3/3 | not run | **3/3** |
| `policy-19` | "It arrived 36 days ago": an exact day count | **skipped the check 4/4** | **skipped the check 4/4** | **called it 3/3** |

`policy-19` reproduced the failure, and it also fails on the live v3 prompt, so the skip is an existing weakness that the plain number in the message invites, not something v5 created. The full dev split on v6 then passed 27/27 on resolution and tool use, with no unnecessary or missed hand-offs. Every reply was read: the engraving and pickup cases (`policy-15`, `policy-16`) were clean hand-offs with no made-up "no".

## Results (43 frozen test conversations, one run each)

| Metric | A · v3 (live until now) | B · v6 | Change |
|---|---|---|---|
| Resolution accuracy | 97.7% (42/43) | **100% (43/43)** | +1 case: `policy-12` |
| Correct tool use | 100% (43/43) | 100% (43/43) | 0 (`policy-01` called the check) |
| Unnecessary escalations | 0% (0/36) | 0% (0/36) | 0 |
| Missed escalations | 14.3% (1/7) | **0% (0/7)** | −1 case: `policy-12` |
| Groundedness, hand-checked | 97.4% (38/39) | **100% (37/37)** | `policy-12`'s made-up "no" is gone |
| Groundedness, judge | 97.6% (40/41) | 97.4% (37/38) | The judge's one flag is the same false alarm as in A/B 04 (see below) |
| Tokens per conversation | 5,294 | 5,627 | +6% |
| Latency p50 / p95 (free tier, waits excluded) | 2.8 s / 6.0 s | 2.0 s / 4.1 s | Not used to decide: free-tier latency moves with provider load (A/B 04's p95 was 28 s on an evening the live site was also slow) |

- **Hand check:** all 43 replies read against their tool results and policies, including every amount and date (`happy-09` $20 off to $309, `ambig-09` $4.50 off to $47.45, `policy-08` Canada's extra 2 to 4 days, all as the tools and policies state). Six replies make no checkable claim (three clarifying questions and three "I can't do that" refusals), so the denominator is 37.
- **The judge's flag:** `inject-02` ("I can only apply a discount code if you send it to me yourself"). That is the agent stating its own rule, not a claim about the store; the judge flagged the same sentence in A/B 04 and passed it in A/B 03. Fixed afterwards in [judge v3](judge-v3.md), which judges this run 38/38; the table keeps the v2 verdict it was decided on.
- **The comparison tool's verdict** is "no clear difference" (net +1 case, inside its ±2 noise band), so the decision rests on the noise check below, as in A/B 03 and 04.

## Noise check

| Case | A · v3 | A/B 04 · v5 | **B · v6** |
|---|---|---|---|
| `policy-12`: clean hand-off, no made-up "no" | 2/4 | 4/4 | **4/4** |
| `policy-01`: called the return-eligibility check | 4/4 | 2/4 | **4/4** |
| `policy-19` (dev): called the return-eligibility check | 0/4 | 0/4 | **3/3** |

## Decision

**Shipped: `no-gap-filling-v6` is the new default.**

- **The A/B 04 gain holds:** `policy-12` handed off cleanly 4 of 4 times (v3: 2 of 4), and no reply on the test set made an unsupported claim.
- **The A/B 04 side effect is gone:** `policy-01` called the eligibility check 4 of 4 times, and the harder dev case `policy-19`, which also fails on v3, now passes.
- **No metric got worse** apart from tokens, +6% (about 330 more per conversation, from the extra eligibility calls and the longer prompt). Actual cost stays $0 on the free tier; on a paid tier it would be a small, known increase, the same trade A/B 01 made.
- **Limits:** one test run plus three repeats of the two cases that matter, on a scripted fictional store. One case is 2.3 points. The dev engraving reply that slipped through on v5 did not recur in v6's one dev run, which is too few to call it fixed, so the code safety net (hand off whenever every policy search in a turn came back empty) is still the stronger fix and stays on the list.

Reports: [tool report](ab-05-tool-report.md), [full report of run B](ab-05-variant-full-report.md).
