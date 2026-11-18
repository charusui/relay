// Milestone 3: async Twilio replies, failure logging, monitoring queries,
// alert rules and the synthetic check. All offline: a fake Twilio API, the
// scripted stand-in model, PGlite in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OfflineModel } from '../src/agent/offlineModel.ts';
import type { ModelClient } from '../src/agent/model.ts';
import { getVariant } from '../src/agent/variants.ts';
import { FALLBACK_REPLY, handleTwilioSms } from '../src/channels/twilioFlow.ts';
import { twilioRestSender } from '../src/channels/twilioRest.ts';
import { RelayDb } from '../src/db/db.ts';
import { handleInbound } from '../src/handler.ts';
import { evaluateAlerts, RULES } from '../src/monitor/alerts.ts';
import { conversationDetail, daily, maskContact, recentAlerts, recentConversations, recentSyntheticRuns, summary } from '../src/monitor/metrics.ts';
import { runSyntheticCheck, SYNTHETIC_CASE_IDS } from '../src/monitor/synthetic.ts';
import { cases } from '../src/eval/cases.ts';
import { MockStore } from '../src/store/store.ts';

async function fakeTwilioApi() {
  const sent: { path: string; auth: string; form: Record<string, string> }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      sent.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? ''), form: Object.fromEntries(new URLSearchParams(raw)) });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"sid":"SM_fake"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { sent, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const failingModel: ModelClient = {
  offline: true,
  provider: 'test',
  modelId: 'always-fails',
  create: async () => {
    throw new Error('model unavailable (test)');
  },
};

test('async mode: webhook answered at once, reply sent through the Messages API, retries never resend', async () => {
  const api = await fakeTwilioApi();
  const db = await RelayDb.open('memory');
  const deps = { db, store: new MockStore(), model: new OfflineModel(), variant: getVariant('baseline') };
  const sendSms = twilioRestSender({ accountSid: 'AC123', authToken: 'secret', apiBase: api.url });
  const params = { From: '+15550100101', To: '+18885550000', Body: 'where is #1042', MessageSid: 'SM1' };

  const first = await handleTwilioSms(deps, { mode: 'async', sendSms, log: () => {} }, params);
  assert.equal(first.status, 200);
  assert.match(first.body, /<Response><\/Response>/); // nothing in the webhook answer itself
  assert.equal(api.sent.length, 0); // the agent has not run yet
  await first.background!();
  assert.equal(api.sent.length, 1);
  assert.equal(api.sent[0].path, '/2010-04-01/Accounts/AC123/Messages.json');
  assert.equal(api.sent[0].auth, `Basic ${Buffer.from('AC123:secret').toString('base64')}`);
  assert.deepEqual([api.sent[0].form.To, api.sent[0].form.From], ['+15550100101', '+18885550000']);
  assert.match(api.sent[0].form.Body, /UPS/);

  const retry = await handleTwilioSms(deps, { mode: 'async', sendSms, log: () => {} }, params);
  assert.match(retry.body, /<Response><\/Response>/);
  assert.equal(retry.background, undefined);
  assert.equal(api.sent.length, 1);

  await db.close();
  await api.close();
});

test('a model failure sends the fallback reply and is logged as a failure', async () => {
  const api = await fakeTwilioApi();
  const db = await RelayDb.open('memory');
  const deps = { db, store: new MockStore(), model: failingModel, variant: getVariant('baseline') };
  const sendSms = twilioRestSender({ accountSid: 'AC123', authToken: 'secret', apiBase: api.url });
  const r = await handleTwilioSms(deps, { mode: 'async', sendSms, log: () => {} }, { From: '+15550100101', To: '+18885550000', Body: 'hi', MessageSid: 'SM2' });
  await r.background!();
  assert.equal(api.sent[0].form.Body, FALLBACK_REPLY);
  const s = await summary(db, { hours: 24 });
  assert.equal(s.failures, 1);
  assert.equal(s.errorRate, 1);
  await db.close();
  await api.close();
});

test('monitoring queries: summary, daily series, list, detail, masking', async () => {
  const db = await RelayDb.open('memory');
  const deps = { db, store: new MockStore(), model: new OfflineModel(), variant: getVariant('baseline') };
  await handleInbound(deps, { channel: 'sms', from: '+15550100101', text: 'where is #1042' });
  await handleInbound(deps, { channel: 'sms', from: '+15550100106', text: 'can I talk to a real person' });
  await handleInbound(deps, { channel: 'sms', from: '+15550100101', text: 'where is #1042', evalRunId: 'eval-x', evalCaseId: 'happy-01' }); // excluded

  const s = await summary(db, { hours: 24 });
  assert.equal(s.conversations, 2);
  assert.equal(s.customerMessages, 2);
  assert.equal(s.turns, 2);
  assert.equal(s.handoffs, 1);
  assert.equal(s.handoffRate, 0.5);
  assert.ok(s.latencyP95Ms !== null && s.avgTokensPerTurn !== null);
  assert.ok(s.toolCalls.some((t) => t.name === 'getTrackingStatus'));
  assert.equal((await summary(db, { hours: 24, traffic: ['synthetic'] })).conversations, 0);

  const days = await daily(db, 7);
  assert.equal(days.length, 7);
  assert.equal(days.at(-1)!.conversations, 2);

  const list = await recentConversations(db);
  assert.equal(list.length, 2);
  assert.ok(list.every((c) => !c.contact.includes('0100101') && !c.contact.includes('0100106')));
  const detail = await conversationDetail(db, list[1].id);
  assert.ok(detail && detail.messages.length === 2 && detail.turns[0].tools.length > 0);

  assert.equal(maskContact('+15550100101'), '+1•••0101');
  assert.equal(maskContact('maya.chen@example.com'), 'm•••@example.com');
  await db.close();
});

test('alert rules fire once per cooldown and reach the notifier', async () => {
  const db = await RelayDb.open('memory');
  for (let i = 0; i < 4; i++) await db.recordFailure({ traffic: 'live', source: 'twilio', message: 'quota' });
  const posted: string[] = [];
  const fired = await evaluateAlerts(db, async (t) => void posted.push(t));
  assert.deepEqual(fired.map((f) => f.rule), ['error_rate']);
  assert.equal(posted.length, 1);
  assert.match(posted[0], /100% of messages failed/);
  assert.deepEqual(await evaluateAlerts(db, async (t) => void posted.push(t)), []); // cooldown
  const alerts = await recentAlerts(db);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].posted, true);

  // A notifier that fails still records the alert, marked as not posted.
  const db2 = await RelayDb.open('memory');
  for (let i = 0; i < 4; i++) await db2.recordFailure({ traffic: 'live', source: 'twilio', message: 'quota' });
  await evaluateAlerts(db2, async () => {
    throw new Error('slack down');
  });
  assert.equal((await recentAlerts(db2))[0].posted, false);
  assert.ok(RULES.every((r) => r.describe.length > 10));
  await db.close();
  await db2.close();
});

test('synthetic check: dev cases only, graded, logged, threads closed', async () => {
  assert.ok(SYNTHETIC_CASE_IDS.every((id) => cases.find((c) => c.id === id)?.split === 'dev'));
  const db = await RelayDb.open('memory');
  const run = await runSyntheticCheck({ db, model: new OfflineModel(), variant: getVariant('baseline') });
  assert.equal(run.total, SYNTHETIC_CASE_IDS.length);
  assert.equal(run.results.length, SYNTHETIC_CASE_IDS.length);
  const runs = await recentSyntheticRuns(db);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].passed, run.passed);
  const open = await db.sql.query<{ n: number }>(`select count(*)::int as n from conversations where traffic = 'synthetic' and status <> 'closed'`);
  assert.equal(open.rows[0].n, 0);
  const s = await summary(db, { hours: 24, traffic: ['synthetic'] });
  assert.ok(s.conversations >= 1);
  // A failing check raises the synthetic_check alert.
  const failing = await runSyntheticCheck({ db, model: failingModel, variant: getVariant('baseline') }, undefined, ['happy-02']);
  assert.equal(failing.passed, 0);
  assert.equal(failing.errors, 1);
  assert.ok((await recentAlerts(db)).some((a) => a.rule === 'synthetic_check'));
  await db.close();
});

test('conversation list: search, filters, outcome, paging, total; previous-period summary; hand-off queue', async () => {
  const { listConversations, openHandoffs } = await import('../src/monitor/metrics.ts');
  const db = await RelayDb.open('memory');
  const deps = { db, store: new MockStore(), model: new OfflineModel(), variant: getVariant('baseline') };
  await handleInbound(deps, { channel: 'sms', from: '+15550100101', text: 'where is #1042' });
  await handleInbound(deps, { channel: 'sms', from: '+15550100106', text: 'can I talk to a real person' });
  await handleInbound(deps, { channel: 'email', from: 'lena.fischer@example.com', text: 'do you ship to the UK?', traffic: 'demo' });
  // A failed message: the customer wrote, no agent reply was logged.
  await handleInbound({ ...deps, model: failingModel }, { channel: 'sms', from: '+15550100109', text: 'hello 100%_odd' }).catch(() => {});

  const all = await listConversations(db, { hours: 24 });
  assert.equal(all.total, 4);
  assert.equal(all.rows.length, 4);
  assert.deepEqual(
    all.rows.map((r) => r.outcome).sort(),
    ['answered', 'answered', 'failed', 'handed_off'],
  );
  assert.ok(all.rows.every((r) => !/0100101|0100106|lena\.fischer/.test(r.contact)));

  assert.equal((await listConversations(db, { hours: 24, q: 'UK' })).total, 1);
  assert.equal((await listConversations(db, { hours: 24, q: '100%_' })).total, 1); // % and _ are literal, not wildcards
  assert.equal((await listConversations(db, { hours: 24, q: 'zzz-nothing' })).total, 0);
  assert.equal((await listConversations(db, { hours: 24, outcome: 'handed_off' })).total, 1);
  assert.equal((await listConversations(db, { hours: 24, outcome: 'failed' })).total, 1);
  assert.equal((await listConversations(db, { hours: 24, channel: 'email' })).total, 1);
  assert.equal((await listConversations(db, { hours: 24, traffic: ['demo'] })).total, 1);
  const page2 = await listConversations(db, { hours: 24, limit: 3, offset: 3 });
  assert.equal(page2.total, 4);
  assert.equal(page2.rows.length, 1);
  const byReplies = await listConversations(db, { hours: 24, sort: 'replies', dir: 'asc' });
  assert.equal(byReplies.rows[0].outcome, 'failed'); // no agent reply was logged, so the fewest replies

  // Previous period: move one conversation (and its rows) 30 hours back.
  const moved = all.rows.find((r) => r.outcome === 'answered' && r.channel === 'sms')!.id;
  for (const t of ['conversations', 'messages', 'turns', 'tool_calls']) {
    const col = t === 'conversations' ? 'id' : 'conversation_id';
    await db.sql.query(`update ${t} set created_at = now() - interval '30 hours' where ${col} = $1`, [moved]);
  }
  assert.equal((await summary(db, { hours: 24 })).conversations, 3);
  assert.equal((await summary(db, { hours: 24, offsetHours: 24 })).conversations, 1);

  const queue = await openHandoffs(db);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].reason, 'angry_customer');
  assert.equal(queue[0].contact, '+1•••0106');
  assert.ok(queue[0].waitingMs >= 0);
  assert.match(queue[0].lastCustomerMessage ?? '', /real person/);
  await db.close();
});
