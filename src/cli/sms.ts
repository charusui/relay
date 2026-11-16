// Send a fake inbound SMS to the local Relay server, signed exactly the way
// Twilio signs its webhooks. No Twilio account needed.
//
//   npm run sms -- "where is my order 1042"
//   npm run sms -- --from +15550100102 "i want to return the rain jacket from 1001"
//   npm run sms -- --sid SM123 "hi"          reuse a MessageSid to test retry dedupe
//   npm run sms -- --bad-signature "hi"      check that forged requests are rejected

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadEnv } from '../config.ts';
import { twilioSignature } from '../channels/twilio.ts';
import { LOCAL_DEV_TWILIO_TOKEN } from '../server.ts';

loadEnv();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string', default: '+15550100101' },
    to: { type: 'string', default: '+15550009999' },
    url: { type: 'string', default: 'http://127.0.0.1:3000/webhooks/twilio/sms' },
    sid: { type: 'string' },
    'bad-signature': { type: 'boolean', default: false },
  },
});
const body = positionals.join(' ');
if (!body) {
  console.error('Usage: npm run sms -- [--from +1555...] "message text"');
  process.exit(1);
}
const params: Record<string, string> = {
  AccountSid: 'AC00000000000000000000000000000000',
  MessageSid: values.sid ?? `SM${randomBytes(16).toString('hex')}`,
  From: values.from!,
  To: values.to!,
  Body: body,
  NumMedia: '0',
};
const token = process.env.TWILIO_AUTH_TOKEN?.trim() || LOCAL_DEV_TWILIO_TOKEN;
const publicUrl = process.env.RELAY_PUBLIC_URL?.trim();
const signedUrl = publicUrl ? `${publicUrl.replace(/\/$/, '')}/webhooks/twilio/sms` : values.url!;
const signature = values['bad-signature'] ? 'forged' : twilioSignature(token, signedUrl, params);

try {
  const res = await fetch(values.url!, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}  (MessageSid ${params.MessageSid})`);
  const message = text.match(/<Message>([\s\S]*?)<\/Message>/)?.[1];
  console.log(message !== undefined ? `Relay replies: ${message.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')}` : text.startsWith('<?xml') ? '(no reply sent)' : text);
} catch (err) {
  console.error(`Could not reach ${values.url}. Is the server running? (npm run server)  ${(err as Error).message}`);
  process.exitCode = 1;
}
