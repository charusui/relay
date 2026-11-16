// Twilio SMS webhook pieces, no Twilio SDK and no account needed:
//  - request signature validation (X-Twilio-Signature), as Twilio specifies it
//  - TwiML responses
//  - SMS keyword handling (STOP / HELP / START) for carrier compliance
// Tested against Twilio's official library in test/twilio.test.ts.

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio's signature for a form-encoded POST: HMAC-SHA1 (key = auth token) over the
 * full request URL followed by every POST parameter's name and value, sorted by name.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function validTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Twilio accepts up to 1,600 characters in one message body. */
export const SMS_MAX_CHARS = 1600;

export function fitSms(text: string): string {
  return text.length <= SMS_MAX_CHARS ? text : `${text.slice(0, SMS_MAX_CHARS - 1).trimEnd()}…`;
}

/** TwiML that replies with one SMS, or an empty response (no reply). */
export function twiml(message?: string): string {
  const body = message ? `<Message>${escapeXml(fitSms(message))}</Message>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

/** Standard SMS keywords. Twilio also enforces STOP itself; Relay must not message an opted-out number. */
export type SmsKeyword = 'stop' | 'start' | 'help' | null;

export function smsKeyword(body: string): SmsKeyword {
  const w = body.trim().toUpperCase();
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'].includes(w)) return 'stop';
  if (['START', 'UNSTOP', 'YES'].includes(w)) return 'start';
  if (['HELP', 'INFO'].includes(w)) return 'help';
  return null;
}

export const HELP_TEXT = 'Pinecrest Supply support: text us about an order, shipping or a return. Reply STOP to opt out. Msg & data rates may apply.';
export const START_TEXT = 'You are opted back in to Pinecrest Supply support messages. Reply STOP to opt out.';
