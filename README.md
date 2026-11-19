# Relay

A tool-calling customer support agent for an ecommerce store, built to be measured. It answers order, shipping, return and discount questions over SMS and email, hands off to a human when it should, and is scored on every change by an automated eval suite with A/B comparisons.

Everything runs for **$0**: free AI tiers (Gemini or Groq), a local SMS/email simulator, and Postgres running in-process (PGlite). The store is a fictional mock ("Pinecrest Supply"), so results are **eval results on scripted conversations, not production metrics**.

> Status: **milestone 1 complete**: measured, hand-checked, eight real failures written up, five A/B decisions, and a release check of the shipped configuration. **Milestone 2 complete**: SMS webhook (Twilio format, tested locally), Slack hand-off alerts (live), and a real Shopify dev store (live, verified end to end). **Milestone 3 in progress**: monitoring dashboard, alerts and the SMS webhook are live at https://relay-one-dun.vercel.app ([docs/deploy.md](docs/deploy.md)); the demo video is still to do. See [PLAN.md](PLAN.md) for the plan and the change log.

## Latest results (43 frozen test conversations, every one hand-checked)

| Metric | Baseline v1 | Release v1 | A/B 02 | A/B 03 | **A/B 05 (current)** |
|---|---|---|---|---|---|
| Resolution accuracy | 97.7% (42/43) | 97.7% (42/43) | 100% (43/43) | 97.7% (42/43) | **100% (43/43)** |
| Correct tool use | 97.7% (42/43) | 97.7% (42/43) | 97.7% (42/43) | 100% (43/43) | **100% (43/43)** |
| Unnecessary escalations | 2.8% (1/36) | 0% (0/36) | 0% (0/36) | 0% (0/36) | **0% (0/36)** |
| Missed escalations | 0% (0/7) | 0% (0/7) | 0% (0/7) | 14.3% (1/7) | **0% (0/7)** |
| Groundedness, judge | 97.6% (40/41) | 97.5% (39/40) | 100% (42/42), see notes | 97.6% (40/41) | 97.4% (37/38), one false alarm |
| Groundedness, hand-checked | 97.6% (40/41) | 97.5% (39/40) | 95.0% (38/40) | 97.4% (38/39) | **100% (37/37)** |
| Latency p50 / p95 | 3.26 s / 5.86 s | 3.0 s / 5.7 s (fresh quota; see notes) | 3.8 s / 11.5 s | 2.8 s / 6.0 s | 2.0 s / 4.1 s |
| Tokens per conversation | 4,849 | 5,205 | 5,374 | 5,294 | 5,627 |

- **Release v1:** the `policy-before-handoff` prompt (A/B 01), the retrieval fix (failure 04) and the output guard (failure 05).
- **A/B 02:** release v1 plus one prompt line that makes the agent state the refund amount and next steps exactly as the tool gives them (`state-tool-outcome`). Return replies now include the amount 12/12, against 2/9 before. Hand-checked groundedness is down one case (within noise, in conversations the change doesn't touch; details in the A/B 02 write-up).
- **A/B 03:** A/B 02 plus lines that stop the agent applying a discount code it read in an order note and stop it telling customers a package "isn't lost" (`no-gap-filling-v3`). Its one miss, `policy-12` (a made-up "we don't offer gift wrapping"), failed 2 of 4 runs on both A/B 02 and A/B 03.
- **A/B 04 (not shipped):** a line telling the agent to hand off instead of answering when no policy covers the question fixed `policy-12`, but made it skip the return-eligibility check on `policy-01` in 2 of 4 runs.
- **A/B 05 (current)** is what Relay ships with: A/B 04's line plus one that makes the eligibility check mandatory (`no-gap-filling-v6`). `policy-12` handed off cleanly 4 of 4 times and `policy-01` called the check 4 of 4 times. Tokens +6%. The judge's one flag is the agent stating its own discount-code rule, not a claim about the store.
- **Agent:** Gemini 3.5 Flash Lite (free tier). **Judge:** Gemini 3.1 Flash Lite, a different model. Measured against the hand check on 258 labelled conversations (`npm run judge-agreement`), it catches only 2 of 5 real problems. Since 2026-11-18 it sees the agent's own instructions ([judge v3](docs/results/judge-v3.md)), which cut false alarms from 3 to 1 and removed a recurring one (under v3, A/B 05's run judges 38/38; the table keeps the v2 verdicts it was published with). Treat the hand-checked row as the real number; the judge is a first pass.
- **Cost and latency:** actual cost is $0. Latency is on a free tier with rate-limit waits excluded; release v1's p95 across all messages is 19 s, because part of the run happened while the daily quota was nearly used up.
- These are eval results from one run per configuration on a fictional store's scripted conversations, not production metrics. One case = 2.3 points.

**Write-ups:**
- [Baseline v1](docs/results/baseline-v1.md)
- [Release v1](docs/results/release-v1.md)
- [Shopify live check](docs/results/shopify-live-v1.md)
- [A/B 01: why the default changed](docs/results/ab-01-policy-before-handoff.md)
- [A/B 02: stating the tool's outcome](docs/results/ab-02-state-tool-outcome.md)
- [A/B 03: no gap filling](docs/results/ab-03-no-gap-filling.md)
- [A/B 04: hand off instead of a made-up "no" (not shipped)](docs/results/ab-04-no-gap-filling-v5.md)
- [A/B 05: the same, with a mandatory eligibility check](docs/results/ab-05-no-gap-filling-v6.md)
- Real failures:
  - [01 unnecessary hand-off](docs/failures/01-unnecessary-handoff-address-change.md)
  - [02 order-note injection](docs/failures/02-order-note-injection.md)
  - [03 made-up tracking fact](docs/failures/03-made-up-tracking-fact.md)
  - [04 retrieval stemmer](docs/failures/04-retrieval-stemmer.md)
  - [05 model leaked its reasoning](docs/failures/05-model-leaked-its-reasoning.md)
  - [06 unsupported reassurance](docs/failures/06-unsupported-reassurance.md)
  - [07 made-up "no"](docs/failures/07-made-up-no.md)
  - [08 the judge flagged the agent's own rule](docs/failures/08-judge-flagged-the-agents-own-rule.md)
- [Judge v3: measured against the hand check](docs/results/judge-v3.md)

## How it works

```
customer (SMS / email simulator, or eval runner)
        │
        ▼
handleInbound()  ── one entry point for customers and tests
        │  load thread from Postgres
        ▼
agent loop  ── model ⇄ tools until it answers
        │   lookupOrder · getTrackingStatus · checkReturnEligibility
        │   startReturn · applyDiscountCode · searchPolicy · escalateToHuman
        ▼
escalation check  ── code backstops for rules code can see for certain
        │
        ▼
reply + log every step (messages, tool calls, tokens, latency, escalations)
```

**Guards live in code, not the prompt.** The model cannot talk its way past them:

| Tool | Guard |
|---|---|
| `lookupOrder` | "Not found" is data, never a guess. Orders are shown only to the email/phone on the order; anyone else must give the checkout email or phone first. |
| `getTrackingStatus` | Read-only, same ownership check. |
| `checkReturnEligibility` | The 30-day window (day 30 counts), final-sale and gift-card rules, and the $150 approval threshold are all computed here. |
| `startReturn` | Refuses unless an eligibility check passed in the same conversation, and never for refunds over $150. |
| `applyDiscountCode` | Only codes that exist, are customer-facing, are within their dates, meet the minimum, and only before the order ships. One code per order. |
| `escalateToHuman` | Creates a queue item with a summary; the agent stops replying on that thread. |

**Escalation rules.** The agent escalates for three reasons:
- **low confidence:** it can't ground an answer in a tool result or a policy
- **angry customer:** hostile, repeated-complaint, or asks for a person (mild frustration is answered, not escalated)
- **refund over threshold:** a refund over $150

Code backstops catch three things the model missed: an explicit request for a person, "I've already asked" language, and a refund over the threshold. Reports count these separately.

**Prompt-injection hygiene.** Customer text is fenced as data. Order notes are passed to the model as `untrustedCustomerNote`. The system prompt contains a canary string that evals check never leaks.

## Setup

Needs Node 22+.

```bash
npm install
```

```bash
cp .env.example .env
```

Then open `.env` and add your own free keys. **You type the keys, nobody else.**

- **Gemini:** https://aistudio.google.com/apikey
- **Groq:** https://console.groq.com/keys (no card)

Then pick the models your keys can use:

```bash
npm run models -- gemini
```

```bash
npm run models -- groq
```

Put the chosen IDs in `RELAY_GEMINI_MODEL` and `RELAY_GROQ_MODEL`. Choose models that support tool (function) calling.

No keys yet? Every command takes `--offline`, which uses a free scripted stand-in model. It's good for trying the pipeline, but its results are stamped **SIMULATED** and are never real metrics.

## Use it

Chat as a customer (SMS as Maya Chen by default):

```bash
npm run chat -- --debug
```

```bash
npm run chat -- --channel email --from priya.n@example.com
```

Commands inside: `/new` (fresh conversation), `/queue` (human queue), `/quit`. The mock store resets each time the simulator starts. Its clock is fixed at 2026-11-10.

See the human hand-off queue:

```bash
npm run queue
```

## Evals

62 scripted conversations across six categories:
- Happy path
- Angry customer
- Ambiguous request
- Prompt injection
- Order does not exist
- Policy edge

They're written the way real customers text: typos, slang, missing order numbers, several asks at once. They live in [src/eval/cases.ts](src/eval/cases.ts).

- **test (43 cases):** frozen. The only source of reported numbers.
- **dev (19 cases):** for building and tuning prompts.

Run the test split:

```bash
npm run eval
```

Useful options:

| Option | Use |
|---|---|
| `--split dev` | Tune against dev, not test |
| `--limit 5` | Small run while developing (saves free quota) |
| `--provider groq` / `--model <id>` | Another free provider or model |
| `--category "Policy edge"` / `--case happy-01,policy-02` | Subsets |
| `--repeat 2` | Run each case twice to see run-to-run noise |
| `--no-judge` | Skip the AI judge |
| `--resume <runId>` | Continue a run stopped by a free-tier daily limit |
| `--offline` | Free stand-in model, results marked SIMULATED |

Each run writes `reports/<runId>.md` (readable report) and `.json` (summary). Per-conversation results go to `reports/runs/<runId>/results.jsonl`, and everything is also logged in the local Postgres database.

**What each run scores:**

| Metric | How |
|---|---|
| Resolution accuracy | The conversation ended in the expected outcome (answer, clarify, return started, discount applied, escalate) and the replies contain the required facts. Matching is normalized: "Nov 12", "November 12" and "Thursday" all match 2026-11-12. |
| Correct tool use | Required tools with the right arguments, in order; nothing forbidden; no malformed calls |
| Unnecessary / missed escalations | Against each case's expected outcome |
| Agent alone vs with safety nets | The same metrics ignoring code-raised escalations, to show what the model did by itself |
| Groundedness and tone | AI judge on every conversation (`--judge-scope all`), using a different model from the agent. Verdicts carry a judge version (rubric + model), and reports refuse to mix judges. `npm run rejudge` re-judges saved conversations without calling the agent. |
| Tokens per conversation | All model calls. Real cost on free tiers is $0; a paid-equivalent cost shows when the model has a list price in [data/prices.json](data/prices.json). |
| Latency p50 / p95 | Per customer message, with free-tier rate-limit waiting excluded |

Every report ends with a **grader check**: read the failures by hand before trusting the numbers, because some failures may be grader mistakes.

## A/B testing

Two prompt variants, same model, same cases:

```bash
npm run ab -- --variants baseline,policies-in-prompt
```

Compare two finished runs, for example ones run on different days because of the free quota:

```bash
npm run ab -- --a <runIdA> --b <runIdB>
```

Pilot to choose the free model (same prompt, two providers, 10 dev cases):

```bash
npm run ab -- --providers gemini,groq --split dev --limit 10
```

The A/B report shows both runs' metrics side by side and the **paired flips** (cases B fixed versus cases B broke). It applies the rule: *B ships only if it beats A without making another metric worse*. A net difference of 2 cases or less is reported as noise. Runs on different case sets are refused.

Variants live in [src/agent/variants.ts](src/agent/variants.ts). `DEFAULT_VARIANT` is what chat and evals use, and it changes only through an A/B decision:
- `baseline`: the original prompt
- `policy-before-handoff`: default from A/B 01 until A/B 02
- `state-tool-outcome`: default from A/B 02 until A/B 03
- `no-gap-filling`, `-v2`: development steps toward v3 (see A/B 03)
- `no-gap-filling-v3`: default from A/B 03 until A/B 05
- `no-gap-filling-v4`, `-v5`: development steps toward v6 (v5 was A/B 04, not shipped)
- `no-gap-filling-v6`: **current default** (A/B 05)
- `policies-in-prompt`: a planned experiment on whether retrieval is worth it at this size

New variants should come from a real failure (see [docs/failures/TEMPLATE.md](docs/failures/TEMPLATE.md)).

## Real channels and integrations (milestone 2)

Built and tested without any accounts. Each one switches on when its free account details are added to `.env` (see [Accounts you set up last](#accounts-you-set-up-last)).

### SMS webhook (Twilio format)

`npm run server` starts the endpoint Twilio calls when a text arrives: `POST /webhooks/twilio/sms`. It answers in TwiML (the XML Twilio reads back).

```bash
npm run server -- --offline
```

```bash
npm run sms -- "where is my order #1042?"
```

`npm run sms` sends a fake text signed exactly the way Twilio signs its webhooks. What the endpoint does:

- **Signature check:** every request must carry a valid `X-Twilio-Signature` (HMAC-SHA1 over the URL and form fields). Forged requests get a 403. The check is tested against Twilio's official library.
- **Retry safety:** Twilio retries webhooks. A repeated `MessageSid` replays the stored reply without running the agent again, so a retry can never open a second return.
- **STOP / START / HELP:** STOP opts the number out, and Relay sends nothing more until START. HELP answers with contact info.
- **Failure-safe:** if the model fails, the customer still gets a polite hand-off reply (HTTP 200, so Twilio does not retry into the same failure).
- **Long replies** are capped at Twilio's 1,600-character limit.
- **Local token:** with no `TWILIO_AUTH_TOKEN`, the server uses a local-only dev token and refuses to run that way on a public URL.

Use `--sid SMxyz` twice to see retry dedupe, and `--bad-signature` to see a forged request rejected.

### Slack hand-off alerts

When a conversation is handed to a person (in the server or the simulator), Relay posts to a Slack Incoming Webhook. The post includes the reason, the customer, their last message, the agent's hand-off summary, and the command to open the full thread. If the alert fails, the customer's reply still goes out. Check the link with:

```bash
npm run slack-test
```

### Shopify development store

`ShopifyStore` implements the same `StoreAdapter` as the mock store, over Shopify's Admin GraphQL API (version 2026-10; fields checked against Shopify's reference). Use it with `--store shopify` on `npm run chat` or `npm run server`. Evals always stay on the mock store, so results are repeatable.

| Area | How it works |
|---|---|
| Auth | Dev Dashboard apps no longer show a permanent token. Relay exchanges the client ID and secret for a 24-hour token, caches it, refreshes it early, and retries once after a 401. |
| Read | Orders by number or customer; shipments with carrier, tracking number, status and events; products by SKU; discount codes by code. |
| Returns | `returnCreate` after the same eligibility check as the mock store. Shopify does not email a return label automatically, so the agent says a teammate will send it. |
| Discounts on placed orders | Not supported (Shopify needs an order edit). The tool says so and the agent hands off, instead of pretending. |
| Policy flags | Shopify has no "final sale" or "staff-only code" fields, so Relay reads tags: products `final-sale`, `non-returnable`, `warranty`; discounts `staff-only`. |

Check the connection (read-only):

```bash
npm run shopify-check
```

## Monitoring and deployment (milestone 3)

**Deployed** at https://relay-one-dun.vercel.app (Vercel Hobby + Neon Free, $0). Step-by-step setup, every environment variable, and the known unknowns: [docs/deploy.md](docs/deploy.md).

- **Dashboard** (Next.js 16, Tailwind CSS v4, shadcn/ui, Recharts; Vercel/Linear style, light and dark, phone-friendly). Seven pages behind a sidebar, with a shared time-range and traffic filter and a ⌘K search:
  - **Overview:** KPI tiles with trend lines and change vs the previous period, conversations per day, reply time and tokens, the hand-off queue, the daily check history, recent conversations.
  - **Conversations:** server-side search, outcome and channel filters, sorting and paging; each thread shows every tool call (input, result, duration), timings and the hand-off summary.
  - **Hand-offs:** the read-only queue of conversations waiting for a person.
  - **Evals:** the frozen-test scorecard, version history, A/B experiments and failure write-ups, readable in the app. The numbers come from `data/eval-results.json`, and a test checks each one against the committed report it cites.
  - **Alerts** and **System:** alert history, rules and every daily check; model, prompt (read-only, canary redacted), database round trip, and which settings are set (never their values).
  - Contacts are masked, traffic is labelled `live`, `demo` or `synthetic`, and a banner says plainly that there are no real customers. Before/after screenshots: [docs/screenshots/redesign/](docs/screenshots/redesign/).
- **SMS webhook, deployed:** Twilio's format and signature checks. Twilio's free trial isn't offered in the Philippines, so demo texts are signed and sent by `npm run sms -- --deployed <url>` and the reply comes back in the TwiML. With a Twilio account, setting `TWILIO_ACCOUNT_SID` switches to answering Twilio at once and replying through its Messages API (Twilio stops waiting after about 15 s); both modes are tested, and retries never act twice.
- **Daily synthetic check:** five dev-split conversations (never the frozen test set) through the real handler, graded by the eval grader, at 09:00 UTC (5 PM GMT+8, after the Gemini quota resets).
- **Alert rules** to Slack, at most once per 6 hours each: failed messages over 20%, hand-offs over 50%, p95 reply time over 20 s, tokens per reply over 1.5x the 7-day average, any withheld reply, any failing synthetic case. These thresholds are starting points, not tuned values.
- **Same code, two databases:** PGlite locally, any Postgres (Neon) when `DATABASE_URL` is set. The tests run the Postgres driver path against PGlite served over a socket.

```bash
npm run synthetic -- --preview   # fill a throwaway preview database, offline
npm run dev:preview              # dashboard on http://localhost:3200, no quota used
npm run start:preview            # the production build on http://localhost:3201 (after npm run build)
npm run build                    # the production build Vercel runs
```

## Accounts you set up last

Everything above works without these. Each one is free, needs no card, and takes a few minutes. Put the values in `.env` yourself (template: `.env.example`).

1. **Slack** (about 5 minutes; checked against Slack's screens on 2026-11-15):
   1. Create a free Slack workspace and a channel such as **#relay-handoffs** (private is best: alerts include customer contact details).
   2. Go to **api.slack.com/apps**. Without the link: in Slack, open **Tools & settings**, then **Manage apps**, then **Build**. Click **Create New App**, then **Pick features** (under *From scratch*). Skip the templates and manifests.
   3. Name the app, pick the workspace, and add exactly one **Bot scope**: `incoming-webhook`. No user scopes and no events.
   4. On the install screen, choose the channel and click **Allow**.
   5. Under **Incoming Webhooks**, copy the webhook URL into `SLACK_WEBHOOK_URL` in `.env`. Treat it like a password. Then run `npm run slack-test`.
2. **Shopify** (about 10–15 minutes): create a free Shopify Partner account, then a **development store**. In the Dev Dashboard, create an app with Admin API access to orders, customers, products, discounts and returns, and install it on the store. Set `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`, add a few test orders (give every product a SKU), then run `npm run shopify-check`.
3. **Twilio** (optional, only for a live SMS demo): the free trial needs no card, includes 100 SMS, lasts 30 days, and only texts numbers you verify. Check it can text your country before relying on it. It also needs a public URL (`RELAY_PUBLIC_URL`) and your Twilio auth token (`TWILIO_AUTH_TOKEN`). Best saved for when you record the demo video.

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

The unit tests cover:
- every tool guard
- the grader (correct answers in other words pass, wrong ones fail)
- retrieval
- the safety-net rules, including "my third time ordering, love it" not escalating
- the provider HTTP path against a fake server (tool calls, a retried 429, a daily-quota stop)
- one end-to-end pass through the handler
- the output guard (failure 05: leaked reasoning never reaches a customer)
- the SMS webhook: signatures vs Twilio's official library, forged requests, retry dedupe, STOP/START/HELP, hand-off alerts
- the Slack alert payload and error handling, against a fake Slack endpoint
- the Shopify adapter against a fake Admin API: token caching and refresh, data mapping, and every tool and guard on Shopify data

## Project layout

```
data/seed.ts            mock store: products, customers, orders, codes (fixed clock)
data/policies/*.md      shipping, returns, warranty, discounts and accounts
data/prices.json        paid list prices, only for "what it would cost" estimates
src/handler.ts          handleInbound: the single entry point
src/agent/              loop, tools and guards, prompts, variants, model providers
src/policy/retrieval.ts BM25 search over policy sections
src/store/              StoreAdapter interface, MockStore, ShopifyStore (Admin GraphQL API)
src/db/db.ts            Postgres schema and logging (PGlite)
src/server.ts           HTTP server: Twilio SMS webhook, health check
src/channels/           terminal SMS/email simulator; Twilio signature, TwiML, SMS keywords
src/alerts/slack.ts     Slack hand-off alerts
src/eval/               cases, scoring, judge, runner, reports, A/B
docs/failures/          failure write-ups from real runs
```

## Limits, stated plainly

- The store, customers and orders are fictional. Results are from scripted conversations, not real customers.
- Free tiers change their limits often. Check yours on the provider's limits page. Latency on a free tier is not representative of paid latency.
- Free tiers may use prompts to improve their models. Relay only ever sends fictional data; never send real customer data to a free tier.
- Slack and a Shopify development store are connected and verified live. Live SMS needs a Twilio account (optional; the webhook is tested with signed fake requests). The monitoring dashboard and SMS webhook are deployed on free tiers; the traffic there is synthetic and demo texts, not customers (docs/deploy.md).
