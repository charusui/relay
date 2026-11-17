// Twilio-format SMS webhook, deployed. Checks the X-Twilio-Signature, then:
//  - with a Twilio account (TWILIO_ACCOUNT_SID set): answers at once (Twilio gives
//    up after about 15 s), runs the agent after the response, and sends the reply
//    through Twilio's Messages API (async mode);
//  - without one: runs the agent and returns the reply in the TwiML (sync mode).
//    Used with `npm run sms -- --deployed <url>`, because Twilio's free trial is
//    not offered in the Philippines.
//
// Needs: TWILIO_AUTH_TOKEN (the signing secret: Twilio's auth token, or a random
// string you make up when there is no Twilio account) and RELAY_PUBLIC_URL (the
// exact base URL the sender signs; signatures are computed over it).

import { after } from 'next/server';
import { validTwilioSignature } from '../../../../src/channels/twilio.ts';
import { handleTwilioSms } from '../../../../src/channels/twilioFlow.ts';
import { twilioSenderFromEnv } from '../../../../src/channels/twilioRest.ts';
import { escalationAlertFromEnv, monitoringNotifierFromEnv } from '../../../../src/alerts/slack.ts';
import { evaluateAlerts } from '../../../../src/monitor/alerts.ts';
import type { Traffic } from '../../../../src/db/db.ts';
import { relay } from '../../../lib/relay.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Run next to the Neon database (AWS us-east-1); the account default region is Singapore.
export const preferredRegion = 'iad1';
export const maxDuration = 300;

const text = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export async function POST(req: Request) {
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!token) return text(503, 'SMS is not configured (TWILIO_AUTH_TOKEN)');
  const sendSms = twilioSenderFromEnv(); // undefined without TWILIO_ACCOUNT_SID: reply in the TwiML instead

  const raw = await req.text();
  if (raw.length > 64 * 1024) return text(413, 'body too large');
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  const u = new URL(req.url);
  const base = process.env.RELAY_PUBLIC_URL?.trim().replace(/\/$/, '') || u.origin;
  const signedUrl = `${base}${u.pathname}${u.search}`;
  if (!validTwilioSignature(token, signedUrl, params, req.headers.get('x-twilio-signature') ?? undefined)) {
    console.warn(`rejected Twilio webhook: bad or missing signature (url ${signedUrl})`);
    return text(403, 'invalid signature');
  }

  const { db, deps } = await relay();
  // Until Relay has real customers, every inbound text is a demo (set RELAY_SMS_TRAFFIC=live when that changes).
  const traffic: Traffic = process.env.RELAY_SMS_TRAFFIC === 'live' ? 'live' : 'demo';
  const notify = monitoringNotifierFromEnv();
  const r = await handleTwilioSms(
    deps,
    {
      mode: sendSms ? 'async' : 'sync',
      sendSms,
      traffic,
      onEscalation: escalationAlertFromEnv(),
      afterMessage: async () => void (await evaluateAlerts(db, notify)),
    },
    params,
  );
  if (r.background) after(r.background);
  return new Response(r.body, { status: r.status, headers: { 'content-type': r.contentType } });
}
