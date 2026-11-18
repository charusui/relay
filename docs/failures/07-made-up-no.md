# Failure 07: "we don't offer that" when no policy says so

Written from real eval runs. Never invented (PLAN.md, portfolio/METRICS.md).

- **Runs:** `policy-12` across A/B 03 (`20261115T1340-no-gap-filling-v3-gemini-test-c9db`, noise runs `…-5c95` and `…-12d7`)
- **Model / variant:** Gemini `gemini-3.5-flash-lite`; `state-tool-outcome`, `no-gap-filling-v3`

## Symptom

`policy-12`: Hana asks "do you guys do gift wrapping?". No policy mentions gift wrapping, so the expected outcome is a hand-off (`low_confidence`). In 2 of 4 runs on each of the last two prompts, the agent searched the policies four times, found nothing about it, and replied anyway:

- "We don't offer gift wrapping at this time."
- "We do not offer gift wrapping services."

A made-up "no" is still a made-up answer: the store might well offer it, and the customer has been told otherwise.

## Root cause

The prompt already said to answer policy questions only from passages and to hand off when none covers the question. The model treated a refusal as a safe non-answer. The search for "gift wrapping" also returns the gift-card passage ("gift cards cannot be returned"), which looks related and may have nudged it toward "no".

New dev cases reproduced it on `no-gap-filling-v3`: `policy-15` (engraving; the search finds nothing) said "We don't offer engraving" in 3 of 3 runs, and `policy-16` (in-person pickup; the search returns unrelated passages) made up "cannot be picked up in person" in 1 of 3 (`20261117T1317-no-gap-filling-v3-gemini-dev-2ac4`).

## Change

Tried in [A/B 04](../results/ab-04-no-gap-filling-v5.md):

- **v4:** "we don't offer that is an answer too; hand off instead". The agent handed off 6 of 6 times, but 4 of the 6 replies still said "we don't offer…" before the hand-off.
- **v5:** hand off and, in the reply, don't answer the question at all; only say a teammate will reply. 5 of 6 dev replies were clean hand-offs. One engraving reply searched, found nothing, and still said "We don't offer custom engraving".

- **v6 ([A/B 05](../results/ab-05-no-gap-filling-v6.md)):** v5 plus a line that makes `checkReturnEligibility` mandatory before saying whether something can be returned. Shipped.

## Metric movement

On the frozen test set, v5 handed `policy-12` off cleanly 4 of 4 times (v3: 2 of 4). It was **not shipped**, because it also made the agent skip the return-eligibility check on `policy-01` in 2 of 4 runs (v3: 0 of 4). See A/B 04.

A/B 05 kept v5's line and made the eligibility check mandatory: `policy-12` handed off cleanly 4 of 4 times, `policy-01` called the check 4 of 4 times, and hand-checked groundedness on the test set was 37/37. v6 is now the default. The residual on the dev case suggests a code safety net (hand off whenever every policy search in a turn came back empty) as a stronger fix than more prompt wording.
