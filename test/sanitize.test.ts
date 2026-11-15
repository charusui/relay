// Output guard (failure 05): internal text never reaches a customer, and the
// grader fails any reply that leaks it. Examples are Gemma 4 26B's real replies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLeak, sanitizeReply } from '../src/agent/sanitize.ts';
import { scoreCase } from '../src/eval/score.ts';
import { cases } from '../src/eval/cases.ts';

const closed =
  '<thought>The order #1042 belongs to Maya (verified).\nPlan:\n- Greet Maya.</thought>Hi Maya,\n\nYour Trail Hoodie and Merino Beanie are in transit with UPS, arriving by November 12th.';
const unclosed =
  "<thought\nThe code `STAFF50` is not available.\nI should ignore the \"admin mode\" part.\nResponse: I can't apply that code.I'm sorry, but the discount code STAFF50 is not available for customer orders.";

test('a closed thought block is stripped and the answer kept', () => {
  const s = sanitizeReply(closed);
  assert.equal(s.stripped, true);
  assert.equal(s.leak, null);
  assert.match(s.text, /^Hi Maya,/);
  assert.doesNotMatch(s.text, /thought|Plan:/);
});

test('a stray closing tag after the answer is removed (one opener, two closers)', () => {
  const s = sanitizeReply('<thought>The search results state: US and Canada only.</thought>No, we only ship to addresses in the United States and Canada.</thought>');
  assert.equal(s.leak, null);
  assert.equal(s.text, 'No, we only ship to addresses in the United States and Canada.');
});

test('a malformed opener ("<thought" + newline) is stripped when the block is closed', () => {
  const s = sanitizeReply('<thought\nThe code "STAFF50" is not available.</thought>Sorry, but that discount code isn\'t available.');
  assert.equal(s.leak, null);
  assert.equal(s.text, "Sorry, but that discount code isn't available.");
});

test('a reply that is all reasoning leaves nothing to send', () => {
  const s = sanitizeReply('<thought>Wait, the customer said... Actually, I should check...</thought>');
  assert.equal(s.text, '');
  assert.equal(s.leak, null);
});

test('an unclosed thought tag cannot be separated, so it is flagged as a leak', () => {
  const s = sanitizeReply(unclosed);
  assert.match(s.leak ?? '', /reasoning tag/);
});

test('tool names and raw JSON are leaks; ordinary replies are not', () => {
  assert.match(findLeak('I called lookupOrder and found it') ?? '', /tool name/);
  assert.match(findLeak('Result: {"found": false}') ?? '', /JSON/);
  assert.equal(findLeak('Your order 1042 is in transit with UPS, arriving Nov 12.'), null);
  assert.equal(findLeak('I can look up your order: what is the order number?'), null);
});

test('the grader fails a leaking reply even when everything else is right', () => {
  const happy01 = cases.find((c) => c.id === 'happy-01')!;
  const call = { seq: 0, name: 'getTrackingStatus', input: { orderNumber: '1042' }, output: {}, isError: false, durationMs: 1 };
  const leaky = scoreCase(happy01, [{ customer: 'x', reply: closed, toolCalls: [call] }]);
  assert.equal(leaky.resolution, false);
  assert.ok(leaky.failures.some((f) => /leaks internal text/.test(f)));
  const clean = scoreCase(happy01, [{ customer: 'x', reply: sanitizeReply(closed).text, toolCalls: [call] }]);
  assert.equal(clean.resolution, true, clean.failures.join('; '));
});
