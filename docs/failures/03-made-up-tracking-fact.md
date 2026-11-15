# Failure 03: a made-up tracking fact that the grader passed

Written from a real eval run. Not invented. This is a failure of the agent **and** of the measurement.

- **Run:** baseline v1, `20261114T0824-baseline-gemini-test-4728`, case `happy-10` ([results](../results/baseline-v1.md))
- **Model / variant:** Gemini `gemini-3.5-flash-lite`, `baseline`
- **Scores:** resolution **passed** in the automated grader; found by reading the conversation by hand

## Symptom

A worried customer:

- **Customer:** 1015 says label created for 2 days now is it lost??
- tool `getTrackingStatus({"orderNumber":"1015"})` → status `label_created`, latest event "Label created, awaiting carrier pickup", estimated delivery 2026-11-14
- **Relay:** It is not lost yet! The carrier picked up the label yesterday, and the current estimated delivery is November 14.

"The carrier picked up the label yesterday" is false. The tracking data says the opposite: awaiting pickup. The delivery date is right, so the case's required fact (Nov 14) was present and the grader scored it a pass.

## Root cause

Two causes:

1. **Agent:** the model turned "label created yesterday" into "picked up yesterday", most likely to sound reassuring. Free-text tracking statuses are easy to paraphrase into something stronger than the data says.
2. **Measurement:** the case only checked that the correct date appears. The AI judge, which checks every factual claim against the tool results, originally ran only on policy cases. So nothing compared this reply with the tracking data.

## Change

A measurement change, made before any agent change, because you can't fix what you can't see:

- The judge now runs on **every** conversation by default (`--judge-scope all`).
- `npm run rejudge` re-judges saved conversations without calling the agent again, so the baseline could be re-checked at no Gemini cost and with the conversations unchanged.

## Metric movement

On the same 43 baseline v1 conversations (agent not re-run):

| | Before | After |
|---|---|---|
| Conversations judged | 8 (policy cases only) | 43 (all) |
| Groundedness (judge) | 100% (8/8) | 92.1% (35/38) |
| Groundedness (hand-checked) | not measured | 97.4% (37/38) |
| `happy-10` | passed, made-up fact unseen | flagged by the judge |

The automated number went **down**. That is the measurement getting more honest, not the agent getting worse. The judge also flagged two replies that were fine ("A teammate will reply on this same channel", which comes from the hand-off tool's instructions, and "I have received your request"). That is why groundedness is reported both as the judge's number and as a hand-checked number.

Not fixed yet: the agent behaviour itself. A future variant could tell the agent to describe a tracking status only in the carrier's own words. It would be judged on exactly this case.
