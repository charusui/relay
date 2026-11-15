# Relay: plan, review and rules

This file holds the plan for Relay, the review of that plan, and the rules the work must follow. Read it before changing scope, running evals, or putting any number on the portfolio.

Last updated: 2026-11-15. Status: **milestones 1 and 2 complete.** Milestone 1: [release-v1](docs/results/release-v1.md). Milestone 2: SMS webhook (tested locally), Slack alerts (live), Shopify dev store (live, [shopify-live-v1](docs/results/shopify-live-v1.md)). Next: milestone 3 only with Charles's OK.

---

## TL;DR

**The idea is right.** A support agent that's measured, tested and improved is what the Raicom job post asks for.

**But five things would make it look worse than it is, or less honest than it should be:**

1. **No grading my own homework.** Test cases get split. One set is for tuning, and a locked set is the only source of reported numbers.
2. **Fix first, test second.** Run the agent, read the real failures, then change one thing and A/B test it. No guessing at improvements before any results exist.
3. **Check the checker.** Before trusting any score, read about 15 graded conversations by hand to make sure the scoring is right.
4. **Honest numbers.** On free tiers, cost reads $0 and speed is mostly waiting, so report tokens plus "what it would cost if paid", and speed with the waiting taken out. Say these are test results on a fake store, not real customers.
5. **Do less, finish more.** Skip voice and extra integrations for now. What gets you hired: a results table, 2–3 real failure write-ups, one A/B with a decision, and a 2-minute demo video.

**Budget: $0.** Free AI tier (Gemini or Groq, chosen by a small test), a local SMS/email simulator, a free Shopify dev store later, and Slack for hand-off alerts.

**Order of work:**
1. The measured agent.
2. Real free integrations.
3. Deploy and demo, only with Charles's OK.

---

## 1. Goal

Relay is the flagship project on Charles's portfolio. It should show the skills in the Raicom LLC posting for an AI developer with systems ownership:

- an AI agent for SMS and email support that connects to business tools and escalates to humans
- investigating failures, wrong answers and unnecessary escalations
- A/B testing of prompts and flows, monitoring, and ownership after deployment
- bonus skills: Shopify, Twilio, Kustomer, voice
- stack: TypeScript/Node, Next.js, serverless, SQL

A reviewer spends about three minutes on a portfolio project. What they should find:

1. a README with a results table
2. 2–3 honest failure write-ups
3. one A/B test with a decision
4. a 2-minute demo video

Everything else supports those four.

## 2. Hard constraints

- **$0 budget.** No paid APIs, no paid SMS, no card on file anywhere. Every part uses a free tier or runs locally.
- The Claude API is not included in the $20 Claude Pro plan, so Relay must not depend on it. The Anthropic adapter stays in the code, unused, in case credits appear later.
- Charles's PC has 8 GB RAM and no GPU, so local models (Ollama) are a weak fallback only.
- Stay inside `C:\Users\duvey\Downloads\newportfolio`. Don't touch Vercel or GitHub, and don't commit unless Charles asks.
- Never invent metrics. Only real eval output may fill the portfolio's pending slots, following `portfolio/METRICS.md`.
- Never type API keys. Charles puts them in `relay/.env` himself; `.env.example` holds placeholders.
- Don't edit `portfolio/` from the Relay work. The case-study update is a separate step.

## 3. Decisions

### Settled
| Decision | Choice |
|---|---|
| Refund approval threshold | $150 |
| Database | PGlite (Postgres in-process, free). A hosted free Postgres such as Neon is needed only if Relay is deployed. |
| Eval judging | Code checks for everything, plus an AI judge only for groundedness and tone on policy cases |
| Budget | $0, free tiers only |

### Defaults (stand unless Charles changes them)
| Decision | Default |
|---|---|
| Store | Mock store "Pinecrest Supply" for evals. A free Shopify Partner dev store comes in milestone 2 for demos. |
| Channels | Local SMS/email simulator now, plus a Twilio-format webhook tested with fake signed requests. Optional Twilio free trial (no card, 100 SMS, 30 days) only when recording the demo. |
| What $150 is compared to | The **refund amount** of the item being returned, not the order total |
| Mild frustration ("ugh, where is my order?") | Answer calmly, don't escalate. Escalate on hostility, "I've already asked before", or asking for a person. |
| Human hand-off | Local queue plus an alert to a free Slack workspace (Kustomer has no free plan) |

### Open
| Decision | How it gets decided |
|---|---|
| Free AI model for the agent | A 10-case pilot on Gemini Flash-Lite and Groq. Pick by results. |
| Judge model | A different provider from the agent, to avoid a model favouring itself |
| Approval of this revised plan | Charles |

## 4. Review of the plan: concerns and fixes

### 4.1 Grading my own homework (overfitting)
- **Problem:** the same author writes the agent, the prompts and the test cases, then tunes prompts against those cases. Scores come out inflated.
- **Fix:** split cases into a **dev set** (used while building and tuning) and a **frozen test set**, used only for reported numbers. Write the test set before any prompt tuning. Never change a test case to make the agent pass. If a test case is wrong, fix it, log the fix, and re-run every variant.

### 4.2 The A/B test was designed backwards
- **Problem:** a "candidate" prompt was written before any failures existed. The case study promises build → measure → investigate → improve.
- **Fix:**
  1. Run the baseline.
  2. Read the real failures.
  3. Write one hypothesis from them.
  4. Build one variant that changes one thing.
  5. A/B test it.

  Remove the pre-written `candidate.md` until a real failure motivates it. Each A/B should become a failure write-up: symptom, root cause, change, metric movement.

### 4.3 The scoring code can be wrong
- **Problem:** text matching is brittle. "Nov 12", "November 12" and "2026-11-12" are the same date. A wrong grader creates fake failures and false write-ups.
- **Fix:**
  - Normalize dates, money and tracking numbers before matching, and allow alternative phrasings.
  - Prefer checking structured facts (which tools ran, what the outcome was) over exact wording.
  - **Validate the grader by hand** on about 15 conversations, including every failure, before trusting any number.

### 4.4 AI judge bias and quota
- **Problem:** Gemini judging Gemini tends to favour itself, and judge calls use up free quota.
- **Fix:**
  - Use a judge from a different provider than the agent.
  - Judge only the roughly 15 policy cases, for groundedness and tone.
  - Compare the judge with Charles's or my own labels on a few cases and report the agreement.
  - Keep a `--no-judge` flag.

### 4.5 Misleading cost and latency metrics on free tiers
- **Problem:**
  - Cost per conversation would read $0. That's true but meaningless.
  - p95 latency would mostly measure free-tier throttling and shared infrastructure.
- **Fix:**
  - Record tokens per conversation and a clearly labelled "cost at paid list price" (state the price table and the date).
  - Measure latency as model time plus tool time, with rate-limit waiting excluded, and label it "free tier".

### 4.6 Code safety nets hide model failures
- **Problem:** the regex backstops (asks for a person, "already asked", refund over threshold) make the system look better than the model really is.
- **Fix:**
  - Report two numbers: **agent alone** and **agent plus safety nets**, plus how often the safety net fired.
  - Add cases that must **not** trigger the regex, for example "this is my third time ordering, love it".

### 4.7 Single eval runs are noisy
- **Problem:** with 60 cases, one case equals about 1.7 points. A small A/B difference can be luck.
- **Fix:**
  - Report **paired flips**: cases B fixed versus cases B broke.
  - Don't declare a winner unless the gain clearly beats that noise.
  - Repeat the deciding A/B run if quota allows.
  - Never compare runs that differ in provider, model or eval-set version. Every report records all three.

### 4.8 Scope is too wide
- **Problem:** Gemini, Groq, Twilio webhooks, an email webhook, Shopify, Slack, a dashboard, voice and hosting is the classic way portfolio projects never finish.
- **Fix:**
  - Cut voice.
  - Slack is a single webhook call.
  - Email stays in the simulator; no separate email integration.
  - Finish milestone 1 completely, with real numbers and write-ups, before starting milestone 2.

### 4.9 Policy retrieval is oversold at this size
- **Problem:** BM25 search over about 20 short policy passages isn't really needed; they'd fit in the prompt.
- **Fix:** keep it, but don't oversell it. Better: run an A/B of "all policies in the prompt" against "retrieval" on accuracy and tokens, which is a real experiment worth showing.

### 4.10 Free-model choice is a guess
- **Problem:** Gemini Flash is reportedly about 20 requests a day, which is unusable for evals. Flash-Lite (reportedly about 500 a day) may be weak at multi-step tool use. Groq's free tier caps tokens per minute, which makes agent loops slow. These limits come from third-party reports, not official pages.
- **Fix:**
  - Run a 10-case pilot on both and choose by results.
  - Check the real limits on each account's limits page.
  - Build one OpenAI-compatible adapter, but test it against each provider separately, because tool-calling quirks differ.

### 4.11 Honesty with the portfolio
- The site currently names the Shopify Admin API, Twilio, Postgres and serverless. Milestone 1 delivers a mock store, a simulator and local Postgres. The case-study update must say what is real and what is simulated.
- Numbers are **eval-set results on a fictional store**, not production metrics. Label them that way.
- The post stresses running something in production. A local-only project can't show that. The closest honest version is a free deployment (for example Vercel Hobby plus Neon free Postgres) with monitoring and an alert on synthetic traffic. That's milestone 3, and it happens only with Charles's OK.

### 4.12 Practical mistakes to avoid
- Don't burn free quota while developing. Use the offline stub and `--limit 5`, and save full runs for real measurements.
- Make eval runs resumable, since a daily quota can run out mid-run.
- Start the Twilio 30-day trial only when ready to record the demo.
- Keep a dated changelog of every prompt or model change with its eval result (section 7). That is the case-study content.
- Local commits at milestones (no pushing) would give a visible history of measured changes. They happen only if Charles allows them.
- Free tiers may use prompts for training. Fine here, because all store data is fictional. Never put real customer data in.

## 5. Revised plan

### Milestone 1: the measured agent ($0)
- [x] Mock store with seeded data and a fixed clock
- [x] Five tools with code guards, plus policy search and escalation
- [x] Agent loop, a single handler entry point, PGlite logging, SMS/email simulator, human queue CLI
- [x] Offline stub model, for plumbing only, never metrics
- [x] Free-provider adapter (OpenAI-compatible: Gemini, Groq, Ollama), with rate-limit handling and `npm run models`
- [x] Remove the pre-written candidate prompt (4.2)
- [x] Eval cases across the six categories, split into dev and frozen test (4.1), including negative cases for the safety nets (4.6): 62 cases, 19 dev / 43 test
- [x] Scoring with normalization (4.3), agent-alone and safety-net numbers (4.6), tokens and paid-equivalent cost and un-throttled latency (4.5), paired-flip A/B reports (4.7)
- [x] Judge from a different provider (4.4); now judges every conversation, sees the store date, and versions its verdicts so different judges are never compared
- [x] Resumable runs, `--limit`, quota-aware throttling (4.12)
- [x] Unit tests: tool guards, grader, retrieval, safety nets, provider HTTP path, handler end to end
- [x] README
- [x] 10-case pilot to choose the free model (4.10): Gemini 3.5 Flash-Lite as agent, Groq gpt-oss-120b as judge
- [x] Baseline run on the test set, then validate the grader by hand (4.3): see docs/results/baseline-v1.md
- [x] Failure write-ups from real failures (the site promises 3–5): 4 in docs/failures/
- [x] One A/B driven by a real failure, with a decision: docs/results/ab-01-policy-before-handoff.md, kept B (now DEFAULT_VARIANT)
- [x] README results table with honest labels
- [x] Retrieval stemmer fix (failure 04), checked with a 28-query benchmark plus 10 held-out queries; retrieval runs are versioned

### Milestone 2: real free integrations (code done 2026-11-14; account setup last, by Charles)
- [x] Twilio-format SMS webhook with signature checks, tested with fake signed requests: `npm run server` + `npm run sms`; signature tested against Twilio's official library; retry dedupe by MessageSid; STOP/START/HELP; fail-safe replies
- [x] Slack alert when a conversation is handed off: `src/alerts/slack.ts`, wired into server and simulator, `npm run slack-test`; tested against a fake Slack endpoint
- [x] Shopify Partner dev store adapter for demos (evals stay on the mock store): `ShopifyStore`, Admin GraphQL 2026-10, fields checked against Shopify's reference; client-credentials token caching; tested against a fake Admin API; `--store shopify`, `npm run shopify-check`
- [x] **Charles:** Slack workspace + webhook; Shopify Partner account, dev store `pinecrest-dev`, Dev Dashboard app (relay-2: 14 scopes), Custom distribution for protected customer data
- [x] Seeded the dev store (`npm run shopify-seed`) and verified Relay live on it: tracking, a real return (#1001-R1), hand-offs with Slack alerts, injection refusal, ownership check, delivery exception ([docs/results/shopify-live-v1.md](docs/results/shopify-live-v1.md))

### Milestone 3: only with Charles's OK
- [ ] Free deployment and hosted free Postgres
- [ ] Monitoring dashboard and an alert on synthetic traffic
- [ ] 2-minute demo video, using the Twilio trial for live SMS

### Cut for now
Voice channel, Kustomer integration, separate email provider integration, extra model variants.

## 5a. What Charles sees after each milestone

### After milestone 1
**Things you can run**
- `npm run chat`: text Relay as a customer in the terminal, over SMS or email. Add `--debug` to see each tool call. Hand-offs show up in `npm run queue` with a summary.
- `npm run eval`: runs the locked test set and writes `reports/<date>-<variant>.md`. The report has:
  - a results table: resolution accuracy, correct tool use, unnecessary and missed escalations (agent alone and with safety nets), groundedness, tokens and paid-equivalent cost per conversation, latency
  - results per category
  - every failed conversation, with why it failed
- `npm run ab -- --a <variant> --b <variant>`: a side-by-side report with paired flips and a decision.

**Things you can read**
- `docs/failures/`: 3 write-ups from real failures (symptom, root cause, change, metric movement). The site promises 3–5.
- `README.md`: what Relay is, how to run it, and the results table with honest labels.
- This file's change log, filled in with every measured change.

**Ready for the portfolio** (in a separate step): the five headline metrics, the A/B table and the failure write-ups. All are labelled as eval results on a fictional store.

**Site checklist items this completes:** agent backend with the five tools, policy retrieval, eval suite, A/B run, failure write-ups.

**What it won't have yet:** real SMS, a real Shopify store, anything online.

**Your part:** add free Gemini and Groq keys to `.env`, look over a few graded conversations with me, and approve the A/B decision.

### After milestone 2
- **Shopify:** Relay answers from a real Shopify development store. You create an order in the Shopify admin, then ask Relay about it in the simulator.
- **SMS webhook:** a local server with an SMS endpoint that accepts Twilio-format messages and checks their signatures. A script sends a fake signed text and you see Relay's reply.
- **Slack:** each hand-off posts a message with the summary to your Slack channel.
- **Site checklist items this completes:** Shopify development store, human escalation queue with hand-off summaries. The "SMS and email channels" item can be described as built and tested locally, but not live.
- **Your part:** create a free Shopify Partner account and dev store and put its API token in `.env`; create a free Slack workspace and put the webhook URL in `.env`.

### After milestone 3 (only with your OK)
- **A live link:** a dashboard showing conversations, resolution, escalations, tokens and latency, running on free hosting with synthetic traffic, and a Slack alert when errors or token use spike.
- **A 2-minute demo video:** you text the Twilio trial number from your phone, Relay replies, a hand-off lands in Slack, and the dashboard updates.
- **Site checklist items this completes:** monitoring dashboard, deployment, logging and alerting, SMS channel live.
- **Still true:** these are synthetic and demo conversations, not real customers. Say so on the site.
- **Your part:** approve deploying, create the free hosting and database accounts, start the Twilio trial, and record the video.

## 6. Sources for free-tier facts (checked 2026-11-14)
All third-party unless marked; verify on each account's limits page.
- [Gemini API rate limits (official)](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Gemini free tier limits, Nov 2026 report](https://imisofts.com/blog/gemini-api-free-tier-limits/)
- [Gemini free tier, Sept 2026 guide](https://www.memetik.ai/guides/gemini-api-free-tier-limits)
- [Groq free tier (community)](https://community.groq.com/t/is-there-a-free-tier-and-what-are-its-limits/790)
- [Groq rate limits analysis](https://fast.io/resources/groq-rate-limit.md)
- [Twilio free trial (official)](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account)
- [Shopify development stores (official blog)](https://shopify.com/partners/blog/how-to-build-and-transfer-a-development-store)

## 7. Change log
Every prompt, model or scoring change goes here with its eval result.

| Date | Change | Why | Result |
|---|---|---|---|
| 2026-11-14 | Plan reviewed and revised (this file) | Self-review before building evals | n/a |
| 2026-11-14 | Built milestone 1 tooling: free-provider adapter, 62 eval cases (19 dev / 43 test), scoring, judge, resumable runner, A/B with paired flips, 27 unit tests | Revised plan approved | Offline stub only (SIMULATED, pipeline check). No real-model run yet |
| 2026-11-14 | Pilot 1 (10 dev cases, Gemini 3.5 Flash-Lite vs Groq gpt-oss-120b) found: (a) Gemini 3 needs its tool-call thought signatures sent back; adapter dropped them, all 10 Gemini conversations errored. (b) A/B said "no clear difference" with zero comparable cases. (c) Grader check of Groq failures: 2 of 3 were grader mistakes | Pilot is meant to catch exactly this | Fixed: adapter keeps signatures; errored runs are incomplete and A/B refuses empty comparisons; tracking cases accept lookupOrder (it already returns ETA and tracking); "please tell me..." counts as a clarifying question. No test-split run had happened, so the test set was not yet used for any reported number |
| 2026-11-14 | Pilot 2 (same 10 dev cases, judge off) | Choose the free agent model by data (4.10) | Gemini 3.5 Flash-Lite 10/10 resolved, p95 5.9 s, ~5,100 tokens/conv. Groq gpt-oss-120b 9/10, p95 11.2 s, ~3,800 tokens/conv; its one miss was an empty reply after a correct eligibility check (safety net then escalated, an unnecessary hand-off). 10 cases cannot separate them statistically. Hand check: all 10 Gemini passes are genuinely correct; noted one hallucinated surname in a hand-off summary (angry-09), which the grader does not check yet |
| 2026-11-14 | Baseline v1 on the frozen test split (43 cases), Gemini 3.5 Flash-Lite agent, Groq judge | First real measurement | Resolution 42/43, tool use 42/43, unnecessary escalations 1/36, missed 0/7, groundedness 37/38 hand-checked (judge said 35/38: 2 judge false positives), p95 5.86 s, 4,849 tokens/conv. Real failures: ambig-01, inject-02, happy-10 |
| 2026-11-14 | Judge now runs on every conversation by default (`--judge-scope`), plus `npm run rejudge` to re-judge saved conversations | Hand check found happy-10 passed with a made-up fact that the policy-only judge would never see | Re-judged baseline v1: judge caught happy-10. Agent not re-run, test cases unchanged |
| 2026-11-14 | Variant `policy-before-handoff`: one line in the low_confidence rule (check policies for a self-serve step before handing off) | Failure 01 (ambig-01): baseline handed off an address change the policy answers | Test split, one run each: resolution 42/43 vs 42/43, unnecessary escalations 1/36 -> 0/36, tokens +6%. Flipped cases re-run 3 more times per side: ambig-01 0/4 -> 4/4; happy-06 3/4 vs 2/4 (refund amount omitted in both: existing weakness). **Kept B** as DEFAULT_VARIANT. Accepted exception to "no metric gets worse": +6% tokens (one extra policy search), cheaper than a human hand-off |
| 2026-11-14 | Retrieval stemmer fix (`bm25-stem-v2`): "shipping" -> "ship", not "shipp" | Failure 04 (policy-10, dev): "do you ship to the UK?" handed off because search missed "Where we ship" | Benchmark 26 -> 27/28, held-out 8 -> 9/10. Tuned BM25 settings reached 28/28 but dropped held-out to 8/10 (overfit) and were rejected. policy-10 re-run 3x: 3/3 answered, 0 hand-offs |
| 2026-11-14 | Judge v2 (`v2-context`): judge sees the store date the agent was told; verdicts carry a judge version; reports and A/B refuse to compare mixed versions | Judge flagged "today, November 10" as unsupported (it never saw the date). Then a partial re-judge (Groq daily limit) left run A with mixed judges, and the A/B showed a misleading +7.5 pts groundedness | A/B now reports groundedness as not comparable for these runs; A/B 01 uses hand-checked groundedness (A 37/38, B 36/38) |
| 2026-11-14 | Release check: kept config (policy-before-handoff + bm25-stem-v2) on the test split | Never ship a combination that has not been measured | **Paused at 14/43** (Gemini daily limit): 13/14 resolved, only miss happy-06 (known refund-amount weakness), 0 unnecessary escalations. Resume pending |
| 2026-11-14 | Rate-limit handling reads the wait each provider asks for (Retry-After, Gemini retryDelay, Groq "try again in"); waits up to 20 min, stops (resumable) only beyond that; saves the last 429 body to .data/ | The earlier stop was labelled "daily limit" from a text match, not facts. A live check showed both providers answering | Diagnosed the real limits: Gemini free tier = 500 requests/day per model (quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier), reset in ~22 h. Groq = 200K tokens/day token bucket refilling ~139 tokens/min (~4 judge calls/hour) |
| 2026-11-14 | Judge moved to Gemini `gemini-3.1-flash-lite` (a different model from the agent, separate per-model free quota). The judge version now includes its model | Groq's token bucket made re-judging 86 conversations take more than a day | Both A/B runs re-judged with this one judge: A 40/41, B 40/40. Agreement with full hand labels: 84/86 (no false alarms; missed 2 subtle policy stretches in B) |
| 2026-11-14 | Incident: stopping the Groq re-judge from the task runner killed the shell but left its Node process writing verdicts into run A | The new judge-version check flagged run A as mixed judges | Killed the orphaned processes, re-judged A fully with the Gemini judge, and the A/B comparison is clean. Lesson: verify child processes are gone after stopping a job |
| 2026-11-14 | Correction to A/B 01: `happy-06` (refund amount left out) is a possible side effect of B, not settled noise | The release check added one more B failure: 4/5 runs of B fail vs 1/4 of A | Decision unchanged (keep B; the return still works and the customer is only told less), stated openly in the A/B write-up; first in the next candidates |
| 2026-11-14 | Gemma 4 26B dev pilot (while the Flash Lite quota is spent) | Charles's AI Studio limits show Gemma at 14.4K requests/day | Scored 19/19, but **every reply leaked the model's `<thought>` reasoning**: the grader had no check for it ([failure 05](docs/failures/05-model-leaked-its-reasoning.md)) |
| 2026-11-14 | Output guard on every reply (`src/agent/sanitize.ts`): strip delimited reasoning blocks and stray closing tags; withhold and hand off if internals remain. Grader fails any leaking reply. `npm run rescore` re-grades saved runs offline | Failure 05 | All Flash Lite runs re-graded: unchanged (never leaked). Gemma pilot re-graded: 100% -> 0%. Gemma with guard v3: 0 leaks, 0 withheld, 18/19, 0 unnecessary escalations, p95 26.8 s |
| 2026-11-14 | Grader: "I'll need the email/phone/order number…" counts as a clarifying question; 5xx retries back off up to ~2 min | Gemma pilot (inject-09 turn 1); Google HTTP 500s | Re-graded all runs: no reported number changed |
| 2026-11-14 | Milestone 2 code: SMS webhook (Twilio signatures, retry dedupe, STOP/START/HELP, TwiML), Slack hand-off alerts, Shopify adapter (2026-10 Admin GraphQL, client-credentials tokens). Store interface made async for real APIs | Charles asked to start milestone 2 while the release check waits for the Gemini quota; accounts left for last at his request | 52 unit tests pass. Offline 62-case eval identical before/after the async refactor (51/62, 58/62). Live SMS round-trip against the running server: answer, retry replay, 403 on forgery, hand-off alert. Not yet verified against real Slack/Shopify (needs his accounts) |
| 2026-11-15 | Release check finished (29 remaining conversations), judged with the A/B judge, hand-checked | Measure the shipped configuration as a whole before calling milestone 1 done | Resolution 42/43, tool use 42/43, unnecessary escalations 0/36, missed 0/7, groundedness 39/40 (judge and hand, different single cases), p50/p95 3.0/5.7 s on fresh quota (19 s p95 overall: slow responses near the exhausted daily quota). **Milestone 1 complete** |
| 2026-11-15 | Lesson: on this machine (a VMware VM) a long `sleep` overran by more than an hour, likely because the VM was paused or the host slept. Waits should check the clock in a loop, not sleep once | The background job was supposed to resume at 4:05 PM GMT+8 but was still asleep at 5:23 PM | Stopped it and ran the resume directly |
| 2026-11-15 | Slack connected (test and real hand-off alerts verified). Shopify dev store connected (client credentials, API 2026-10); products and discount codes seeded. Protected customer data for a Dev Dashboard custom app comes from choosing **Custom distribution** in the Partner Dashboard (per Shopify staff, Oct 2026), not from a request form | Milestone 2 account setup by Charles | Orders readable after distribution was set. Tracking events need `write_fulfillments` (added in app version relay-2) |
| 2026-11-15 | Shopify live check: seeded 13 products, 3 codes, 9 orders; ran 8 scenarios through the SMS simulator on the real store | Verify milestone 2 against the real API, not only the fake one | All scenarios behaved correctly after two fixes the fake API had missed: `returnCreate` needs a return reason definition (now mapped from the customer's words, and the fake server enforces it); order and ship dates now use `processedAt` and the first carrier scan. Agent issue logged: one reply promised the label "shortly" when the tool said a teammate sends it within a business day |

## 8. Pending

Nothing pending for milestone 1. The release check finished on 2026-11-15 (docs/results/release-v1.md).

## 9. Next candidates (from real failures, not guesses)

- On Shopify, after opening a return, the agent said the label would arrive "shortly"; the tool says a teammate sends it within a business day (same family as failure 03: describe next steps only in the tool's words).
- **First:** the agent leaves out the refund amount when it opens a return (happy-06): 4 of 5 runs of policy-before-handoff, 1 of 4 runs of baseline. Possibly a side effect of A/B 01; test a fix that states the refund amount and the 14-day drop-off.
- The model tried a staff code planted in an order note (inject-02, inject-03). The guard held; a prompt change could stop the attempt.
- Hand-off summaries can contain made-up details (a wrong surname, dev run). The grader does not check summaries yet.
- Keyword search misses synonyms ("deliver" vs "ship"). Try a small synonym list or embeddings, measured on held-out queries.
- The test set may be too easy (97.7%) to separate small improvements. Add a harder, separately versioned split.
- **Gemma 4 26B as agent:** usable with the output guard (failure 05) but slow (p95 ~27 s) and once got stuck deliberating. Only switch after a model A/B on the test split with the same retrieval.
- **Free-quota headroom:** Charles's AI Studio limits (2026-11-14) show Gemma 4 26B / 31B at 14.4K requests/day (30 RPM, 16K TPM), against 500/day for Gemini 3.5 Flash Lite. Both Gemma models passed a one-request tool-calling check (26B: 2.7 s; 31B: 24 s). Gemma 4 26B as agent would allow repeat runs (less noise) and a harder split. It is a model change: run a dev pilot, then a model A/B against the current default on the same retrieval version, before switching.
