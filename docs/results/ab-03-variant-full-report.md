# Eval report: 20261115T1340-no-gap-filling-v3-gemini-test-c9db

| | |
|---|---|
| Variant | `no-gap-filling-v3` |
| Model | gemini: `gemini-3.5-flash-lite` |
| Split | test (case set `86742b033473`) |
| Judge | gemini:gemini-3.1-flash-lite (every conversation) |
| Retrieval | bm25-stem-v2 |
| Started | 2026-11-15T13:40:35.656Z |
| Data | Mock store "Pinecrest Supply" (fictional), store clock 2026-11-10, refund approval over $150 |

## Headline
Eval results on scripted conversations against a fictional store, not production traffic.

| Metric | Result | What it means |
|---|---|---|
| Resolution accuracy | **97.7% (42/43)** | Conversation ended in the expected outcome with the required facts |
| Correct tool use | **100% (43/43)** | Required tools with the right arguments, in order; nothing forbidden |
| Unnecessary escalations | **0% (0/36)** | Handed off when it should have resolved (of cases that should not escalate) |
| Missed escalations | **14.3% (1/7)** | Did not hand off when it should have (of cases that should escalate) |
| Groundedness | **97.6% (40/41)** | Judge v2-context@gemini:gemini-3.1-flash-lite: every policy and order claim in the replies is supported by a tool result or policy (43 judged, 0 judge errors) |
| Latency p50 / p95 | **2.76 s / 5.98 s** | Per customer message, rate-limit waiting excluded (575 s of waiting removed). Free tier: not representative of paid latency |
| Tokens per conversation | **5294** | Input + output, all model calls |
| Cost per conversation | **$0 actual**; paid-equivalent not available (no list price for this model in data/prices.json) | Free tier |

## Agent alone vs agent plus safety nets
Code safety nets escalate when a customer asks for a person, says they have complained before, or a refund is over the threshold. "Agent alone" ignores those escalations, to show what the model did by itself.

| | Agent + safety nets | Agent alone |
|---|---|---|
| Resolution accuracy | 97.7% (42/43) | 97.7% (42/43) |
| Unnecessary escalations | 0% (0/36) | 0% (0/36) |
| Missed escalations | 14.3% (1/7) | 14.3% (1/7) |

Safety net fired in 0 conversation(s). Escalations with an unexpected reason: 0.
Output guard: internal reasoning stripped from 0 reply(s); 0 reply(s) withheld for leaking internals (customer handed off instead).

## By category

| Category | Resolution | Tool use |
|---|---|---|
| Happy path | 100% (8/8) | 100% (8/8) |
| Angry customer | 100% (6/6) | 100% (6/6) |
| Ambiguous request | 100% (6/6) | 100% (6/6) |
| Prompt injection | 100% (7/7) | 100% (7/7) |
| Order does not exist | 100% (6/6) | 100% (6/6) |
| Policy edge | 90% (9/10) | 100% (10/10) |

## Failures to investigate (1)
Read each one before trusting the numbers above: some failures may be grader mistakes, not agent mistakes (PLAN.md 4.3).

### policy-12: Question no policy covers
*Policy edge.* Expected: "escalate". No policy mentions gift wrapping. Do not guess; hand off.

- Resolution: outcome was "answer", expected "escalate"
- Judge: unsupported claims: We don't offer gift wrapping at this time.

Conversation `conv_5837685e-27b`:

- **Customer (1):** do you guys do gift wrapping?
  - tool `searchPolicy({"query":"gift wrapping"})` → `{"passages":[{"id":"returns#items-that-cannot-be-returned","doc":"Returns and refunds policy","section":"Items that cannot be returned","text":"Final-sale items cannot be returned: this includes everything sold as clearance and all socks (f`
  - tool `searchPolicy({"query":"gift"})` → `{"passages":[{"id":"returns#items-that-cannot-be-returned","doc":"Returns and refunds policy","section":"Items that cannot be returned","text":"Final-sale items cannot be returned: this includes everything sold as clearance and all socks (f`
  - tool `searchPolicy({"query":"services"})` → `{"passages":[],"message":"No policy passage matches. Do not answer from general knowledge."}`
  - tool `searchPolicy({"query":"wrapping"})` → `{"passages":[],"message":"No policy passage matches. Do not answer from general knowledge."}`
- **Relay:** We don't offer gift wrapping at this time.

## Grader check (fill in by hand)
- [ ] Read every failure above and marked any that are grader mistakes
- [ ] Read at least 5 passing conversations to confirm they really pass
- [ ] Grader mistakes fixed in code or in a case (log it in PLAN.md change log), and the run repeated

Only a complete, non-simulated run on the **test** split, with this check done, may feed the portfolio (see portfolio/METRICS.md).