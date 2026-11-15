# Failure 04: "do you ship to the UK?" was handed to a person because search missed the answer

Written from a real failed eval run. Not invented.

- **Run:** `20261114T0905-policy-before-handoff-gemini-dev-68cf` (dev split), case `policy-10`
- **Model / variant:** Gemini `gemini-3.5-flash-lite`, `policy-before-handoff`

## Symptom

- **Customer:** do you ship to the UK?
- tool `searchPolicy({"query":"international shipping UK"})` → top passage "Shipping speeds and costs"
- tool `searchPolicy({"query":"international shipping destinations"})` → the same
- tool `searchPolicy({"query":"shipping"})` → the same
- tool `escalateToHuman({"reason":"low_confidence","summary":"... Shipping policy mentions US and Canada but does not state whether UK shipping is available."})`
- **Relay:** A teammate will reply on this same channel.

The policies answer this directly ("Pinecrest Supply ships to addresses in the United States and Canada only"). The model searched three times and never saw that passage, then reasonably handed off. An unnecessary escalation.

## Root cause

**A retrieval bug, not the model or the prompt.** The keyword search stems words before matching, and its tiny stemmer turned "shipping" into "shipp". "shipp" never matches "ship" or "ships", which is how the "Where we ship" passage is written. So every query phrased with "shipping" ranked other passages first. "Which countries do you ship to" worked; "international shipping UK" did not.

## Change

One change: the stemmer now undoubles a final consonant left after removing -ing/-ed ("shipp" → "ship"), as the standard Porter stemmer does. File: `src/policy/retrieval.ts`.

How it was checked, so the fix isn't just tuned to this one question:

1. Built a **retrieval benchmark** of 28 realistic customer phrasings, each with the passage that must come back in the top 3 (`test/retrieval.test.ts`).
2. Wrote 10 more **held-out** questions afterwards and never tuned on them.
3. Also tried tuning the BM25 ranking settings. That reached 28/28 on the benchmark but **dropped** on the held-out set (9 → 8), which is overfitting, so it was rejected. Only the stemmer fix shipped.

## Metric movement

| Retrieval | Benchmark (28) | Held-out (10) |
|---|---|---|
| Before (old stemmer) | 26 | 8 |
| **After (stemmer fix)** | **27** | **9** |
| Rejected: stemmer fix + tuned BM25 | 28 | 8 |

**The real failing conversation, after the fix** (run `20261114T0948-policy-before-handoff-gemini-dev-28e8`, `policy-10` 3 times): **3/3 answered correctly, 0 hand-offs.** Every search returned "Where we ship" first. One reply: *"We only ship to the United States and Canada, so we can't ship to the UK."* Before the fix: 0/1, handed off.

Still missed, and kept visible as a known limit: "shipping to canada time" (the right passage ranks 4th) and the held-out "do you deliver to germany" ("deliver" never matches "ship"). These are vocabulary gaps in keyword search. The honest fixes are a small synonym list or embeddings, each measured on held-out questions, not tuning until these particular questions pass.

This retrieval change affects every variant, so it is **not** part of the failure 01 A/B, which compares prompts on the old retrieval. Any later run uses the new retrieval and must be compared only against runs that also use it.
