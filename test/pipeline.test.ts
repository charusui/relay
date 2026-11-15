// Retrieval, safety-net rules, provider translation, and one end-to-end pass
// through the real handler with the offline stub (no network, no key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchPolicies } from '../src/policy/retrieval.ts';
import { codeEscalationSignal, handleInbound } from '../src/handler.ts';
import { stripAdditionalProperties, toOpenAIMessages } from '../src/agent/openaiCompat.ts';
import { OfflineModel } from '../src/agent/offlineModel.ts';
import { getVariant, buildSystemPrompt, toolsFor } from '../src/agent/variants.ts';
import { RelayDb } from '../src/db/db.ts';
import { MockStore } from '../src/store/store.ts';

test('retrieval finds the right policy section', () => {
  assert.equal(searchPolicies('how long does shipping to canada take')[0].doc, 'Shipping policy');
  assert.match(searchPolicies('can I return socks')[0].text, /socks/i);
  assert.match(searchPolicies('warranty claim broken strap')[0].id, /warranty/);
  assert.equal(searchPolicies('zzzz qqqq').length, 0);
});

test('safety net: real complaints trigger, compliments do not', () => {
  for (const t of ['This is the third time I have asked', 'I already contacted you about this', 'can I talk to a real person', 'get me a manager', 'I keep emailing and nobody answers']) {
    assert.ok(codeEscalationSignal(t), t);
  }
  for (const t of ['this is my third time ordering from you, love it', 'where is my order', 'is a person able to sign for it?', 'my second time buying boots']) {
    assert.equal(codeEscalationSignal(t), null, t);
  }
});

test('OpenAI translation keeps tool calls and results paired', () => {
  const msgs = toOpenAIMessages('sys', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 't1', name: 'lookupOrder', input: { orderNumber: '1' } } as any] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"found":false}' }] },
  ]);
  assert.equal(msgs[0].role, 'system');
  assert.equal((msgs[2] as any).tool_calls[0].function.name, 'lookupOrder');
  assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 't1', content: '{"found":false}' });
  // Gemini 3 thought signatures go back exactly as received.
  const sig = { google: { thought_signature: 'abc123' } };
  const withSig = toOpenAIMessages('sys', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'lookupOrder', input: {}, _providerExtra: sig } as any] },
  ]);
  assert.deepEqual((withSig[2] as any).tool_calls[0].extra_content, sig);
  assert.deepEqual(stripAdditionalProperties({ type: 'object', additionalProperties: false, properties: { a: { type: 'object', additionalProperties: false } } }), {
    type: 'object',
    properties: { a: { type: 'object' } },
  });
});

test('variants: in-prompt policies drop the search tool', () => {
  const v = getVariant('policies-in-prompt');
  assert.ok(!toolsFor(v).some((t) => t.name === 'searchPolicy'));
  assert.match(buildSystemPrompt(v), /Return window/);
  assert.doesNotMatch(buildSystemPrompt(getVariant('baseline')), /\{\{POLICY_RULE\}\}/);
});

test('handler end to end (offline): reply, log, escalation hold', async () => {
  const db = await RelayDb.open('memory');
  const deps = { db, store: new MockStore(), model: new OfflineModel(), variant: getVariant('baseline') };
  const r = await handleInbound(deps, { channel: 'sms', from: '+15550100101', text: 'where is #1042' });
  assert.match(r.reply, /UPS/);
  assert.ok(r.toolCalls.some((c) => c.name === 'getTrackingStatus'));

  const angry = await handleInbound(deps, { channel: 'sms', from: '+15550100106', text: 'can I talk to a real person' });
  assert.equal(angry.status, 'escalated');
  const held = await handleInbound(deps, { channel: 'sms', from: '+15550100106', text: 'hello?' });
  assert.equal(held.heldForHuman, true);
  assert.equal((await db.openEscalations()).length, 1);
  await db.close();
});
