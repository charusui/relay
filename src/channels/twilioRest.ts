// Sending an SMS through Twilio's Messages API (async reply mode), with fetch
// and no SDK. On a trial account Twilio only delivers to verified numbers and
// to the Twilio Virtual Phone.

import { fitSms } from './twilio.ts';
import type { SendSms } from './twilioFlow.ts';

export function twilioRestSender(opts: { accountSid: string; authToken: string; apiBase?: string }): SendSms {
  const base = (opts.apiBase ?? 'https://api.twilio.com').replace(/\/$/, '');
  const auth = Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString('base64');
  return async (to, from, body) => {
    const res = await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(opts.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: fitSms(body) }).toString(),
    });
    if (!res.ok) throw new Error(`Twilio Messages API returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
}

/** The sender from the environment, or undefined when TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not both set. */
export function twilioSenderFromEnv(): SendSms | undefined {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) return undefined;
  return twilioRestSender({ accountSid, authToken, apiBase: process.env.TWILIO_API_BASE?.trim() || undefined });
}
