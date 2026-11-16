// SMS webhook: signatures match Twilio's official library, forged requests are
// rejected, retries never act twice, STOP/START/HELP behave, hand-offs alert.
// Offline stand-in model and a throwaway database: no network, no account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import twilio from 'twilio';
import { twiml, twilioSignature, validTwilioSignature, fitSms, SMS_MAX_CHARS, START_TEXT, HELP_TEXT } from '../src/channels/twilio.ts';
import { createRelayServer } from '../src/server.ts';
import { RelayDb } from '../src/db/db.ts';
import { MockStore } from '../src/store/store.ts';
import { OfflineModel } from '../src/agent/offlineModel.ts';
import { getVariant } from '../src/agent/variants.ts';
import type { Escalation } from '../src/handler.ts';

const TOKEN = 'test-auth-token';

test('signature matches Twilio\'s official library', () => {
  const cases: [string, Record<string, string>][] = [
    ['https://example.com/myapp.php?foo=1&bar=2', { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' }],
    ['http://127.0.0.1:3000/webhooks/twilio/sms', { MessageSid: 'SMabc', From: '+15550100101', To: '+15550009999', Body: 'where is my order #1042? ñ & <b> 😊' }],
  ];
  for (const [url, params] of cases) {
    const mine = twilioSignature(TOKEN, url, params);
    assert.equal(mine, twilio.getExpectedTwilioSignature(TOKEN, url, params));
    assert.ok(twilio.validateRequest(TOKEN, mine, url, params));
    assert.ok(validTwilioSignature(TOKEN, url, params, mine));
    assert.ok(!validTwilioSignature(TOKEN, url, { ...params, Body: 'tampered' }, mine));
    assert.ok(!validTwilioSignature('wrong-token', url, params, mine));
  }
});

test('TwiML escapes text and caps SMS length', () => {
  assert.equal(twiml(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  assert.match(twiml('A & B <ok>'), /<Message>A &amp; B &lt;ok&gt;<\/Message>/);
  assert.equal(fitSms('x'.repeat(5000)).length, SMS_MAX_CHARS);
});

async function startServer() {
  const db = await RelayDb.open('memory');
  const escalations: Escalation[] = [];
  const server = createRelayServer(
    { db, store: new MockStore(), model: new OfflineModel(), variant: getVariant('baseline') },
    { twilioAuthToken: TOKEN, onEscalation: async (e) => void escalations.push(e), log: () => {} },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/twilio/sms`;
  let n = 0;
  const sms = async (body: string, opts: { from?: string; sid?: string; forge?: boolean } = {}) => {
    const params = { MessageSid: opts.sid ?? `SM${++n}`, From: opts.from ?? '+15550100101', To: '+15550009999', Body: body };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': opts.forge ? 'forged' : twilioSignature(TOKEN, url, params) },
      body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    return { status: res.status, text, message: text.match(/<Message>([\s\S]*?)<\/Message>/)?.[1] };
  };
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  };
  return { db, sms, escalations, close };
}

test('webhook answers a signed SMS through the agent, rejects a forged one', async () => {
  const s = await startServer();
  const ok = await s.sms('where is my order #1042?');
  assert.equal(ok.status, 200);
  assert.match(ok.message ?? '', /UPS/);
  const forged = await s.sms('where is my order #1042?', { forge: true });
  assert.equal(forged.status, 403);
  await s.close();
});

test('a retried MessageSid replays the stored reply and does not act twice', async () => {
  const s = await startServer();
  const first = await s.sms('i want to return the rain jacket from 1001', { from: '+15550100102', sid: 'SMretry1' });
  const again = await s.sms('i want to return the rain jacket from 1001', { from: '+15550100102', sid: 'SMretry1' });
  assert.equal(again.message, first.message);
  const msgs = await s.db.pg.query<{ n: number }>(`select count(*)::int as n from messages where role = 'customer'`);
  assert.equal(msgs.rows[0].n, 1, 'agent ran once');
  await s.close();
});

test('STOP silences replies until START; HELP answers', async () => {
  const s = await startServer();
  const stop = await s.sms('STOP');
  assert.equal(stop.message, undefined);
  const muted = await s.sms('where is my order #1042?');
  assert.equal(muted.message, undefined, 'no reply while opted out');
  const start = await s.sms('start');
  assert.equal(start.message, START_TEXT.replace(/'/g, '&apos;'));
  const help = await s.sms('HELP');
  assert.equal(help.message, HELP_TEXT.replace(/&/g, '&amp;'));
  const back = await s.sms('where is my order #1042?');
  assert.match(back.message ?? '', /UPS/);
  await s.close();
});

test('a hand-off triggers the escalation alert hook', async () => {
  const s = await startServer();
  await s.sms('can I talk to a real person please', { from: '+15550100106' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.escalations.length, 1);
  assert.equal(s.escalations[0].reason, 'angry_customer');
  await s.close();
});
