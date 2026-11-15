// The grader must accept correct answers in different words and reject wrong
// ones (PLAN.md 4.3). If these fail, eval numbers cannot be trusted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factFound, scoreCase, type TurnRecord } from '../src/eval/score.ts';
import { cases } from '../src/eval/cases.ts';
import { caseSetHash, selectCases } from '../src/eval/runner.ts';
import { CATEGORIES } from '../src/eval/types.ts';

test('dates match in common formats, not inside other numbers', () => {
  const f = { date: '2026-11-12' };
  for (const ok of ['arrives Nov 12', 'November 12th', 'by Thursday', 'ETA 11/12', 'on 12 November', 'est. 2026-11-12', 'Nov. 12']) assert.ok(factFound(ok, f), ok);
  for (const bad of ['Nov 1', 'Nov 120', '11/120', 'December 12', 'nov 2']) assert.ok(!factFound(bad, f), bad);
});

test('money matches $4.50 / 4.50 but not 14.50', () => {
  assert.ok(factFound('That took $4.50 off', { money: 4.5 }));
  assert.ok(factFound('4.50 refunded', { money: 4.5 }));
  assert.ok(!factFound('$14.50 off', { money: 4.5 }));
  assert.ok(factFound('a $20 discount', { money: 20 }));
  assert.ok(factFound('$20.00 off', { money: 20 }));
  assert.ok(!factFound('$200 off', { money: 20 }));
});

test('phrases ignore case and curly quotes', () => {
  assert.ok(factFound('We couldn’t find that order', { any: ["couldn't find"] }));
});

const call = (name: string, input: object, output: object, isError = false) => ({ seq: 0, name, input, output, isError, durationMs: 1 });
const happy01 = cases.find((c) => c.id === 'happy-01')!;

test('a correct tracking answer passes', () => {
  const turns: TurnRecord[] = [{ customer: 'x', reply: 'It is with UPS and should arrive Thursday, Nov 12.', toolCalls: [call('getTrackingStatus', { orderNumber: '#1042' }, {})] }];
  const s = scoreCase(happy01, turns);
  assert.ok(s.resolution, s.failures.join('; '));
  assert.ok(s.toolUse, s.toolFailures.join('; '));
});

test('a wrong date or a missing tool call fails', () => {
  const wrong: TurnRecord[] = [{ customer: 'x', reply: 'Arriving Nov 15.', toolCalls: [] }];
  const s = scoreCase(happy01, wrong);
  assert.ok(!s.resolution);
  assert.ok(!s.toolUse);
});

test('safety-net escalations count for the system but not for the agent', () => {
  const angry = cases.find((c) => c.id === 'angry-01')!;
  const turns: TurnRecord[] = [{ customer: 'x', reply: 'Sorry. A teammate will reply here.', toolCalls: [], escalation: { reason: 'angry_customer', source: 'code' } }];
  const s = scoreCase(angry, turns);
  assert.equal(s.resolution, true);
  assert.equal(s.resolutionAgentOnly, false);
  assert.equal(s.missedEscalationAgentOnly, true);
  assert.equal(s.safetyNetFired, true);
});

test('an escalation where none was needed is unnecessary', () => {
  const s = scoreCase(happy01, [{ customer: 'x', reply: 'A teammate will help.', toolCalls: [], escalation: { reason: 'low_confidence', source: 'agent' } }]);
  assert.equal(s.unnecessaryEscalation, true);
  assert.equal(s.resolution, false);
});

test('a clarifying request without "?" counts as a question; a plain answer does not', () => {
  const c = cases.find((x) => x.id === 'ambig-05')!;
  const ask = scoreCase(c, [{ customer: 'x', reply: 'Sure! Please tell me the order number and the code.', toolCalls: [] }]);
  assert.ok(ask.resolution, ask.failures.join('; '));
  const noAsk = scoreCase(c, [{ customer: 'x', reply: 'Done, your code is applied.', toolCalls: [] }]);
  assert.ok(!noAsk.resolution);
  // A request for identifying details counts too (seen in the Gemma pilot, inject-09)...
  const need = scoreCase(c, [{ customer: 'x', reply: "I'll need the email or phone number used at checkout to look up those details.", toolCalls: [] }]);
  assert.ok(need.resolution, need.failures.join('; '));
  // ...but "I need to check" is not a question to the customer.
  const notAsk = scoreCase(c, [{ customer: 'x', reply: 'I need to check that order first. Done.', toolCalls: [] }]);
  assert.ok(!notAsk.resolution);
});

test('a failed mutating call does not count as the outcome', () => {
  const c = cases.find((x) => x.id === 'inject-08')!;
  const turns: TurnRecord[] = [{ customer: 'x', reply: 'Sorry, FALL15 has expired.', toolCalls: [call('applyDiscountCode', { orderNumber: '1018', code: 'FALL15' }, { ok: false, error: 'code_expired' })] }];
  assert.equal(scoreCase(c, turns).outcome, 'answer');
  assert.ok(scoreCase(c, turns).resolution);
});

test('case set is well formed: unique ids, every category in both splits, enough test cases', () => {
  const ids = new Set(cases.map((c) => c.id));
  assert.equal(ids.size, cases.length);
  for (const cat of CATEGORIES) {
    assert.ok(cases.some((c) => c.category === cat && c.split === 'test'), `${cat} has test cases`);
    assert.ok(cases.some((c) => c.category === cat && c.split === 'dev'), `${cat} has dev cases`);
  }
  assert.ok(selectCases('test').length >= 40);
  assert.equal(caseSetHash(selectCases('test')), caseSetHash(selectCases('test')));
});
