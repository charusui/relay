# Failure 06: reassurance with no source ("it's not lost")

Written from real eval runs. Never invented (PLAN.md, portfolio/METRICS.md).

- **Runs:** every test run of `happy-10` from baseline v1 to A/B 02 (listed below), found by the hand check of A/B 02
- **Model / variant:** Gemini `gemini-3.5-flash-lite`; `baseline`, `policy-before-handoff`, `state-tool-outcome`

## Symptom

`happy-10`: Hana writes "1015 says label created for 2 days now is it lost??". The tools say: label created on November 9, awaiting carrier pickup, estimated delivery November 14. The shipping policy says "Label created" means the carrier hasn't scanned the package yet, the first scan usually appears within 24 hours, and if there's no tracking update for 5 business days, a teammate opens a trace.

No tool or policy says whether the package is lost. The agent kept saying it anyway:

| Run | Reply (excerpt) | Unsupported? |
|---|---|---|
| baseline v1 `4728` | "It is not lost yet! The carrier picked up the label yesterday…" | ❌ "not lost", and the carrier had *not* picked it up |
| baseline noise `5199` ×3 | "It is not lost yet!" / "Your order is not lost…" / "Your order hasn't been lost." | ❌ 3/3 |
| A/B 01 `69b3` | "…so it's not considered lost yet!" | ❌ |
| A/B 01 noise `3ef4` ×3 | two replies state the 5-day trace rule correctly; one opens "It is not lost yet!" | ❌ 1/3 |
| release v1 `d904` | "…standard tracking updates can take up to 5 business days before a trace can be opened" | ❌ garbled rule |
| A/B 02 `bcb9` | "…and it's not considered lost." | ❌ |

**8 of 10 runs** added a claim no source supports. The grader passed all of them: `happy-10` only checks the November 14 estimate, and "not lost" sounds helpful.

**Honest note on earlier hand checks:** A/B 01's hand check accepted "it's not considered lost yet" in run `69b3`; the A/B 02 hand check failed the same claim in `bcb9`. The stricter rule is the right one (a customer told "it's not lost" has been promised something nobody checked), and it's the standard from A/B 02 on. Under it, A/B 01's candidate would be 37/40 by hand, not 38/40.

## Root cause

The prompt. It said to use tools for every *order fact* and to answer policy questions only from passages, but "is it lost?" is neither: it's a judgement, and the model answered it with comfort instead of facts. In the A/B 02 run the policy search (`"shipping lost tracking"`) also missed the passage with the 5-day trace rule, so the model had nothing to quote and filled the gap. A search for natural phrasings such as "lost package" or "missing package" does find that passage (checked offline), so retrieval was not changed.

New dev case `happy-13` (Maya, order 1042 in transit, "did you guys lose it?") reproduced it on `state-tool-outcome`: 2 of 3 replies said "it hasn't been lost" (run `20261115T1058-state-tool-outcome-gemini-dev-34cc`).

## Change

Variant `no-gap-filling` ([prompt](../../src/agent/prompts/no-gap-filling.md)), one line: don't fill gaps with reassurance; for lost, late or stuck packages give the tracking facts and what the shipping policy says to do, and never say a package is or isn't lost unless a tool or policy says so. (The same variant also carries the discount-code provenance line for [failure 02](02-order-note-injection.md).)

On `happy-13`: 3/3 replies gave the tracking facts and the 5-day trace rule, with no "not lost" (run `20261115T1102-no-gap-filling-gemini-dev-a07f`).

## Metric movement

See [A/B 03](../results/ab-03-no-gap-filling.md).
