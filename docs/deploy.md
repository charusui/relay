# Deploying Relay (milestone 3)

Everything here is free with no card: Vercel Hobby (app, dashboard, SMS webhook, daily cron), Neon Free (Postgres) and a second Gemini key.

**No Twilio account.** Twilio's free trial is not offered in the Philippines ("Trials are currently unavailable in Philippines", seen at sign-up on 2026-11-15), and upgrading costs money. The deployed SMS webhook speaks Twilio's format and checks Twilio's signature exactly as it would with a real account (the signing code is tested against Twilio's official library). Messages are sent to it by `npm run sms -- --deployed <url>`, which signs them the way Twilio does. If a Twilio account is ever added, setting `TWILIO_ACCOUNT_SID` switches the webhook to real-Twilio mode (answer at once, reply through the Messages API); that path is built and tested too.

**Status (2026-11-15, 9:10 PM GMT+8): deployed** at https://relay-one-dun.vercel.app (Vercel project `relay`, team charusuis-projects; Neon project `relay`, AWS us-east-1). Functions run in `iad1`; a database round trip from the function takes about 1.2 ms (`/api/health` reports it). First live results: a tracking text answered from the Shopify dev store, a hand-off, a forged signature rejected (403), the cron route refusing callers without the secret (401). Both Gemini keys then hit their 500/day limit, so live texts get the fallback reply until the quota resets at 4 PM GMT+8; the failed synthetic checks and one real `error_rate` alert (sent to Slack) from that are on the dashboard. Live replies took 8 to 16 s, of which only 1.2 to 3.6 s was work: the rest was Relay's own pacing (`RELAY_GEMINI_RPM=8` spaces model calls about 7.5 s apart).

**Deployed with Charles's go-ahead on 2026-11-15.** The code is built and tested locally (`npm test`, `npm run build`, and production-mode checks of both webhook modes). Secrets are pasted by Charles into Vercel's dashboard and his own `.env`; they never go in a file Claude writes or in the repo.

## What it looks like when deployed

| URL | What it does |
|---|---|
| `/` | Monitoring dashboard: conversations, hand-off rate, failed messages, reply time p50/p95, tokens, daily charts, synthetic check history, alerts, recent conversations (contacts masked) |
| `/conversations/<id>` | One conversation with its tool calls, timings and hand-off summary |
| `POST /api/twilio/sms` | Twilio-format SMS webhook. Rejects anything without a valid signature. Without a Twilio account it returns Relay's reply in its TwiML answer |
| `GET /api/cron/synthetic` | Daily synthetic check, called by Vercel Cron at 09:00 UTC (5 PM GMT+8, after the Gemini quota resets). Refuses anyone without `CRON_SECRET` |
| `GET /api/health` | Liveness and a database round trip. Spends no model quota |

Free-plan limits that shaped this: Vercel Hobby functions run at most 300 s and Hobby cron jobs run at most once a day ([Vercel docs](https://vercel.com/docs/functions/limitations), [cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)); Neon Free has 1 GB storage and suspends compute after 5 minutes idle, so the first request after a quiet spell is slower ([Neon pricing](https://neon.com/pricing)).

## Everything Charles will need to do (all free, in this order)

Keep the values in a private note **outside** the project folder, labelled with the names below, and delete it once they're in Vercel.

1. **A second Gemini key, in a new project** (`GEMINI_API_KEY`). Google's free daily limit is per *project* per model (the quota id in Gemini's own 429 response is `GenerateRequestsPerDayPerProjectPerModel-FreeTier`), so a key in a new project gets its own 500/day and live traffic never eats the eval quota. Google AI Studio: Get API key, Create API key, create it in a **new project** named `relay-live`.
2. **Neon project** (`DATABASE_URL`). Name `relay`, region **AWS US East 1 (N. Virginia)**, only Postgres turned on. Connect, connection pooling **on**, copy the string (starts `postgresql://`, contains `-pooler`).
3. **Two random secrets** (`CRON_SECRET` and `TWILIO_AUTH_TOKEN`). Run this twice in a terminal and keep both outputs:
   `node -e "console.log(crypto.randomUUID())"`
   `TWILIO_AUTH_TOKEN` here is not from Twilio: it's the shared secret your PC signs demo texts with and the deployed app checks. It goes in **two** places: Vercel and your own `.env`.
4. **Vercel login**: run `npx vercel login` and log in in the browser with your portfolio account.
5. **Say "create the project"**: Claude links the project to a new, empty Vercel project (separate from the portfolio). Nothing is public yet.
6. **Paste the environment variables** into Vercel: the relay project, Settings, Environment Variables, Production. Table below.
7. **Say "deploy"**: Claude deploys and gives you the link. Add `RELAY_PUBLIC_URL` (that link) in Vercel and in `.env`, then Claude redeploys once.
8. **Try it**: `npm run sms -- --deployed https://<your-link> "where is my order 1042?"` prints Relay's reply, the conversation appears on the dashboard, and a hand-off posts to Slack.

## Environment variables for Vercel (Production)

| Name | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Neon pooled connection string | Required. Without it the app would try local PGlite, which doesn't persist on Vercel |
| `RELAY_PROVIDER` | `gemini` | |
| `GEMINI_API_KEY` | the **new-project** key (`relay-live`) | Keeps live traffic off the eval quota |
| `RELAY_GEMINI_MODEL` | `gemini-3.5-flash-lite` | Same model the evals measured |
| `RELAY_GEMINI_RPM` | `8` | |
| `RELAY_MAX_RATE_LIMIT_WAIT_MS` | `60000` | Wait at most 1 min for a rate limit, then send the fallback reply (functions stop at 300 s) |
| `CRON_SECRET` | random secret 1 | Vercel sends it to the cron route automatically |
| `TWILIO_AUTH_TOKEN` | random secret 2 | The same value goes in `.env` so `npm run sms -- --deployed` can sign |
| `RELAY_PUBLIC_URL` | `https://<your-project>.vercel.app` | Known after the first deploy; add it, then redeploy |
| `SLACK_WEBHOOK_URL` | your existing Slack webhook (from `.env`) | Hand-off alerts and monitoring alerts |
| `RELAY_STORE` | `shopify` (or leave unset for the mock store) | With `shopify`, also add `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` from `.env`. The mock store resets on every request on Vercel, so returns don't persist there |

Leave unset: `TWILIO_ACCOUNT_SID` (no Twilio account), `RELAY_SMS_TRAFFIC` (inbound texts are labelled `demo`), `GROQ_*` and `RELAY_JUDGE_*` (evals run on your PC), `RELAY_DB_DIR`.

## Known unknowns

- **Cold starts.** Neon's compute sleeps after 5 idle minutes and Vercel functions start cold, so the first text after a quiet spell takes a few seconds longer.
- **Cron timing.** Hobby cron runs within the scheduled hour, not at the minute.
- **No real phone in the loop.** The demo shows the full deployed path (signed webhook, agent, database, dashboard, Slack), but texts come from a script, not a phone carrier. The portfolio should say so.

## Checking a deployment

```bash
curl https://<your-project>.vercel.app/api/health
```

The daily check can be triggered by hand with the secret (spends about 15 Gemini requests from the `relay-live` key):

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" https://<your-project>.vercel.app/api/cron/synthetic
```

## Local preview (no accounts, no quota)

```bash
npm run synthetic -- --preview
npm run dev:preview
```

Then open http://localhost:3200. The preview uses the scripted stand-in model and its own throwaway database, so reply times and tokens show as zero.
