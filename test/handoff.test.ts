// Hand-off summaries are read by a support teammate, so internal details
// (reason codes, tool names, "I must escalate") must never reach Slack, the
// dashboard or the queue, whether the model writes them or code does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelClient, ModelRequest, ModelResponse } from '../src/agent/model.ts';
import { cleanHandoffSummary } from '../src/agent/handoff-summary.ts';
import { getVariant } from '../src/agent/variants.ts';
import type { EscalationAlertInfo } from '../src/alerts/slack.ts';
import { slackEscalationMessage } from '../src/alerts/slack.ts';
import { RelayDb } from '../src/db/db.ts';
import { handleInbound, type Escalation } from '../src/handler.ts';
import { conversationDetail, openHandoffs } from '../src/monitor/metrics.ts';
import { MockStore } from '../src/store/store.ts';

// The exact summary the model wrote in the demo recording (conversation conv_87d99748-ec7).
const LEAKED = 'The customer asked if we do gift wrapping. The store policies do not mention gift wrapping, so I must escalate with low_confidence.';
const INTERNAL = /low_confidence|angry_customer|refund_over_threshold|escalateToHuman|searchPolicy|lookupOrder|checkReturnEligibility|\bI (must|will|need to) escalate|Escalated by rule|ended abnormally/i;

test('cleanHandoffSummary removes reason codes, tool names and self-narrated hand-offs, and keeps the facts', () => {
  const cases: [string, string][] = [
    [LEAKED, 'The customer asked if we do gift wrapping. The store policies do not mention gift wrapping.'],
    ['Customer asked for a person. I will escalate this.', 'Customer asked for a person.'],
    ['Escalating with reason angry_customer: customer is upset about order #1042.', 'Customer is upset about order #1042.'],
    ['I checked lookupOrder and searchPolicy; nothing about engraving.', 'I checked the order lookup and the store policies; nothing about engraving.'],
  ];
  for (const [raw, want] of cases) assert.equal(cleanHandoffSummary(raw), want);
});

test('cleanHandoffSummary leaves a good summary alone and never returns an empty note', () => {
  const good = 'Customer asked whether we offer gift wrapping. No store policy covers it, so a teammate should answer.';
  assert.equal(cleanHandoffSummary(good), good);
  assert.match(cleanHandoffSummary('I must escalate.'), /needs a teammate/);
  assert.match(cleanHandoffSummary(''), /needs a teammate/);
});

/** A model that hands off with a leaky summary on its first call, then writes the customer reply. */
function handOffModel(summary: string): ModelClient {
  let calls = 0;
  const res = (content: unknown[], stopReason: string): ModelResponse => ({
    content: content as ModelResponse['content'],
    stopReason,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: 'test',
    waitMs: 0,
    requestMs: 1,
  });
  return {
    offline: true,
    provider: 'test',
    modelId: 'hand-off',
    async create(_req: ModelRequest) {
      calls++;
      if (calls === 1) return res([{ type: 'tool_use', id: 'tu_1', name: 'escalateToHuman', input: { reason: 'low_confidence', summary } }], 'tool_use');
      return res([{ type: 'text', text: 'A teammate will reply here.', citations: null }], 'end_turn');
    },
  };
}

/** A model that just answers, so only the code safety net can hand off. */
const chattyModel: ModelClient = {
  offline: true,
  provider: 'test',
  modelId: 'chatty',
  async create() {
    return {
      content: [{ type: 'text', text: 'Happy to help!', citations: null }] as ModelResponse['content'],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'test',
      waitMs: 0,
      requestMs: 1,
    };
  },
};

test('an agent hand-off is stored, alerted and shown with a clean summary', async () => {
  const db = await RelayDb.open('memory');
  const variant = getVariant('no-gap-filling-v6');
  const alerts: { e: Escalation; info: EscalationAlertInfo }[] = [];
  const r = await handleInbound({ db, store: new MockStore(), model: handOffModel(LEAKED), variant }, { channel: 'sms', from: '+15550100171', text: 'do you guys do gift wrapping?', traffic: 'demo' });
  assert.equal(r.status, 'escalated');
  assert.ok(r.escalation);
  alerts.push({ e: r.escalation, info: { conversationId: r.conversationId, channel: 'sms', from: '+15550100171', text: 'do you guys do gift wrapping?' } });

  // Stored row (what the queue reads), the dashboard queue, and the thread page.
  const stored = await db.sql.query<{ summary: string }>('select summary from escalations where conversation_id = $1', [r.conversationId]);
  const queue = await openHandoffs(db);
  const detail = await conversationDetail(db, r.conversationId);
  for (const s of [r.escalation.summary, stored.rows[0].summary, queue[0].summary, detail!.escalations[0].summary]) {
    assert.doesNotMatch(s, INTERNAL, s);
    assert.match(s, /gift wrapping/);
  }

  // The Slack alert: clean summary, link to the thread, no internal ids or commands.
  const msg = JSON.stringify(slackEscalationMessage(alerts[0].e, alerts[0].info, { dashboardUrl: 'https://relay.example.com/' }));
  assert.doesNotMatch(msg, INTERNAL);
  assert.ok(msg.includes(`<https://relay.example.com/conversations/${r.conversationId}|Open the conversation in the dashboard>`));
  assert.doesNotMatch(msg, /npm run|esc_/);
  await db.close();
});

test('code-raised hand-offs are written in plain English too', async () => {
  const db = await RelayDb.open('memory');
  const r = await handleInbound(
    { db, store: new MockStore(), model: chattyModel, variant: getVariant('no-gap-filling-v6') },
    { channel: 'sms', from: '+15550100106', text: 'can I talk to a real person please' },
  );
  assert.equal(r.escalation?.source, 'code');
  assert.equal(r.escalation?.summary, 'Customer asked for a person, so a teammate should take over. Their message: "can I talk to a real person please"');
  await db.close();
});

test('summaries stored before this fix are cleaned when the dashboard shows them', async () => {
  const db = await RelayDb.open('memory');
  const r = await handleInbound(
    { db, store: new MockStore(), model: chattyModel, variant: getVariant('no-gap-filling-v6') },
    { channel: 'sms', from: '+15550100172', text: 'hello', traffic: 'demo' },
  );
  await db.createEscalation({ conversationId: r.conversationId, reason: 'low_confidence', source: 'agent', summary: LEAKED });
  const queue = await openHandoffs(db);
  const item = queue.find((h) => h.conversationId === r.conversationId);
  assert.ok(item, 'hand-off listed');
  assert.doesNotMatch(item.summary, INTERNAL);
  await db.close();
});
