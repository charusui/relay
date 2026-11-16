# A/B 01: `baseline` vs `policy-before-handoff`

| | |
|---|---|
| Hypothesis | The baseline hands off self-serve requests because its rule says to hand off whenever no tool can do the job ([failure 01](../failures/01-unnecessary-handoff-address-change.md)). Telling it to check the policies first removes those hand-offs without hurting anything else. |
| Change | One line in the system prompt (the `low_confidence` rule) |
| Held constant | Model (Gemini `gemini-3.5-flash-lite`), tools, retrieval (`bm25-stem-v1`), the 43 frozen test cases |
| Runs | A `20261114T0824-baseline-gemini-test-4728`, B `20261114T0913-policy-before-handoff-gemini-test-69b3` |
| Noise check | The 4 conversations that flipped, re-run 3 more times on each version: A `20261114T0934-baseline-gemini-test-5199`, B `20261114T0940-policy-before-handoff-gemini-test-3ef4` |

## Results (43 frozen test conversations, one run each)

| Metric | A · baseline | B · candidate | Change |
|---|---|---|---|
| Resolution accuracy | 97.7% (42/43) | 97.7% (42/43) | 0 |
| Correct tool use | 97.7% (42/43) | 97.7% (42/43) | 0 |
| Unnecessary escalations | 2.8% (1/36) | 0% (0/36) | −1 case |
| Missed escalations | 0% (0/7) | 0% (0/7) | 0 |
| Groundedness, judge (same judge for both) | 97.6% (40/41) | 100% (40/40) | +1 case |
| Groundedness, hand-checked | 97.6% (40/41) | 95.0% (38/40) | −1 case |
| Tokens per conversation | 4,849 | 5,120 | +6% |
| Latency p95 (free tier, waits excluded) | 5.86 s | 6.65 s | +0.8 s; free-tier latency varies run to run |

**How groundedness was judged.** The judge changed during the experiment twice:
1. It was given the store date the agent is told.
2. Groq's free token limit ran out mid re-judge, which left run A judged by two different judges. The A/B tool caught the mix and refused to compare.

Both runs were then re-judged with **one judge**, Gemini `gemini-3.1-flash-lite`: a different model from the agent, on Google's separate per-model free quota. Every conversation was also read by hand.

The judge agrees with the hand labels on **84 of 86** conversations:
- In A it flags exactly the one real problem (`happy-10`).
- In B it misses two subtle policy stretches (`happy-06` "whenever you're ready" against the 14-day rule, and `angry-05` "a day or two" against "usually within 24 hours").
- It raised no false alarms.

The hand-checked row is the stricter of the two.

## Noise check (each flipped case run 4 times in total per version)

| Case | A | B |
|---|---|---|
| `ambig-01` (target) | 0/4 | 4/4 |
| `happy-06` | 3/4 | 2/4 |
| `happy-10` | 3/4 | 4/4 |
| `angry-05` | 4/4 | 4/4 |

Hand-checked groundedness across these 16 conversations per side: A had 1 made-up fact (`happy-10`, first run); B had 2 policy stretches (`happy-06` "whenever you're ready" against the 14-day rule, and `angry-05` "a day or two" against "usually within 24 hours"), both in its first run. They don't recur in the repeats, which points to sampling noise rather than an effect of the change.

**Correction after the release check (more data on `happy-06`):** the release-check run of B left out the refund amount again. Across every run so far, `happy-06` fails in **4 of 5** runs of B and **1 of 4** runs of A. At this sample size that isn't statistically settled, but it is no longer fair to call it noise. B may make the agent likelier to skip the refund amount when it opens a return. In every one of those runs the return itself was opened correctly and the label emailed; only the amount is missing from the message.

**Correction (2026-11-15):** this hand check accepted `happy-10` in run B (`69b3`): "your estimated delivery is November 14, so it's not considered lost yet!". No tool or policy says whether a package is lost, and from A/B 02 on that claim counts as unsupported ([failure 06](../failures/06-unsupported-reassurance.md)). Under that stricter rule, B's hand-checked groundedness here is 37/40, not 38/40. The noise check changes too: A's three `happy-10` repeats all said "not lost", and one of B's three did. The decision doesn't change: it rested on escalations, not groundedness.

## Decision

**Keep B, with one known trade-off and one possible side effect, both stated.**

- **The gain:** B fixes the target failure every time (0/4 → 4/4) and removes the only unnecessary hand-off on the test set. A self-serve request no longer costs a person's time.
- **The trade-off:** about 6% more tokens (one extra policy search). Recorded in PLAN.md as a deliberate exception to "no metric gets worse".
- **The possible side effect:** the refund amount is left out more often (`happy-06`, 4/5 vs 1/4). The return still works; the customer is told less. This is the next fix to test, and it is listed first in PLAN.md's next candidates.

Found along the way, as separate work:
- The agent sometimes omits the refund amount when it opens a return (`happy-06`, in both versions).
- A retrieval stemming bug ([failure 04](../failures/04-retrieval-stemmer.md)), fixed as its own change and measured separately.
