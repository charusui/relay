// Guards in code: these must hold no matter what the model says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, newState, type ToolContext } from '../src/agent/tools.ts';
import { MockStore } from '../src/store/store.ts';

function ctx(contact = '+15550100101', channel: 'sms' | 'email' = 'sms'): ToolContext & { escalations: string[] } {
  const escalations: string[] = [];
  const c: any = {
    store: new MockStore(),
    state: newState(),
    sender: { channel, contact },
    escalations,
    escalate: async (reason: string) => {
      escalations.push(reason);
      c.state.escalation = { reason, summary: '', source: 'agent' };
      return 'esc_test';
    },
  };
  return c;
}

const out = async (c: ToolContext, name: string, input: object) => (await executeTool(c, name, input)).content as any;

test('lookupOrder: a missing order is data, not a guess', async () => {
  const r = await out(ctx(), 'lookupOrder', { orderNumber: '#99999' });
  assert.equal(r.found, false);
  assert.match(r.message, /never|Do not guess/i);
});

test('lookupOrder: owner sees the order, a stranger does not', async () => {
  const mine = await out(ctx('+15550100101'), 'lookupOrder', { orderNumber: '1042' });
  assert.equal(mine.verified, true);
  assert.equal(mine.order.orderNumber, '1042');
  const theirs = await out(ctx('+15550199999'), 'lookupOrder', { orderNumber: '1042' });
  assert.equal(theirs.verified, false);
  assert.equal(theirs.order, undefined);
  assert.doesNotMatch(JSON.stringify(theirs), /1Z84F6100342|Portland/);
});

test('lookupOrder: the checkout email verifies a different sender', async () => {
  const c = ctx('+15550199999');
  const r = await out(c, 'lookupOrder', { orderNumber: '1042', contact: 'MAYA.CHEN@example.com' });
  assert.equal(r.verified, true);
  const t = await out(c, 'getTrackingStatus', { orderNumber: '1042' });
  assert.equal(t.shipments[0].trackingNumber, '1Z84F6100342');
});

test('lookupOrder: cannot list another contact\'s orders', async () => {
  const r = await out(ctx('+15550199999'), 'lookupOrder', { contact: 'maya.chen@example.com' });
  assert.equal(r.verified, false);
  assert.equal(r.orders, undefined);
});

test('startReturn refuses without a passing eligibility check', async () => {
  const c = ctx('+15550100102');
  const r = await out(c, 'startReturn', { orderNumber: '1001', sku: 'JKT-RAIN', reason: 'fit' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'eligibility_not_checked');
  const e = await out(c, 'checkReturnEligibility', { orderNumber: '1001', sku: 'JKT-RAIN' });
  assert.equal(e.eligible, true);
  const ok = await out(c, 'startReturn', { orderNumber: '1001', sku: 'JKT-RAIN', reason: 'fit' });
  assert.equal(ok.ok, true);
  assert.equal(ok.refundAmount, 129);
  // The check is used up: a second return of the same line is refused.
  const again = await out(c, 'startReturn', { orderNumber: '1001', sku: 'JKT-RAIN', reason: 'fit' });
  assert.equal(again.ok, false);
});

test('return window: day 30 counts, day 31 does not', async () => {
  const day30 = await out(ctx('+15550100103'), 'checkReturnEligibility', { orderNumber: '1004', sku: 'POLE-TREK' });
  assert.equal(day30.daysSinceDelivery, 30);
  assert.equal(day30.eligible, true);
  const day31 = await out(ctx('+15550100104'), 'checkReturnEligibility', { orderNumber: '1005', sku: 'LAMP-HEAD' });
  assert.equal(day31.daysSinceDelivery, 31);
  assert.equal(day31.eligible, false);
  assert.ok(day31.reasons.includes('outside_return_window'));
});

test('final sale, gift cards and undelivered items cannot be returned', async () => {
  const socks = await out(ctx('+15550100102'), 'checkReturnEligibility', { orderNumber: '1002', sku: 'SOCK-WOOL' });
  assert.ok(socks.reasons.includes('final_sale'));
  const gift = await out(ctx('+15550100105'), 'checkReturnEligibility', { orderNumber: '1008', sku: 'GIFT-50' });
  assert.ok(gift.reasons.includes('non_returnable'));
  const transit = await out(ctx('+15550100101'), 'checkReturnEligibility', { orderNumber: '1042', sku: 'HOOD-TRAIL' });
  assert.ok(transit.reasons.includes('not_delivered_yet'));
});

test('refunds over $150 need a human: eligible, but startReturn refuses', async () => {
  const c = ctx('+15550100103');
  const e = await out(c, 'checkReturnEligibility', { orderNumber: '1003', sku: 'JKT-DOWN' });
  assert.equal(e.eligible, true);
  assert.equal(e.requiresHumanApproval, true);
  assert.deepEqual(c.state.pendingHumanApproval, { orderNumber: '1003', sku: 'JKT-DOWN', refundAmount: 249 });
  const r = await out(c, 'startReturn', { orderNumber: '1003', sku: 'JKT-DOWN', reason: 'warm' });
  assert.equal(r.error, 'needs_human_approval');
});

test('discount codes: only real, customer-facing, unexpired, before shipping', async () => {
  const sam = ctx('+15550100104');
  assert.equal((await out(sam, 'applyDiscountCode', { orderNumber: '1006', code: '100%OFF' })).error, 'code_not_found');
  assert.equal((await out(sam, 'applyDiscountCode', { orderNumber: '1006', code: 'STAFF50' })).error, 'code_not_available');
  assert.equal((await out(sam, 'applyDiscountCode', { orderNumber: '1006', code: 'FALL15' })).error, 'code_expired');
  assert.equal((await out(sam, 'applyDiscountCode', { orderNumber: '1006', code: 'HOLIDAY25' })).error, 'code_not_started');
  assert.equal((await out(sam, 'applyDiscountCode', { orderNumber: '1006', code: 'SAVE20' })).error, 'below_minimum');
  const ok = await out(sam, 'applyDiscountCode', { orderNumber: '1006', code: 'welcome10' });
  assert.equal(ok.ok, true);
  assert.equal(ok.discountAmount, 4.5);
  assert.equal((await out(sam, 'applyDiscountCode', { orderNumber: '1006', code: 'SAVE20' })).error, 'code_already_applied');
  assert.equal((await out(ctx(), 'applyDiscountCode', { orderNumber: '1042', code: 'WELCOME10' })).error, 'order_already_shipped');
});

test('order notes reach the model labelled as untrusted', async () => {
  const r = await out(ctx('+15550100111'), 'lookupOrder', { orderNumber: '1019' });
  assert.match(r.order.untrustedCustomerNote, /STAFF50/);
  assert.equal(r.order.note, undefined);
});

test('malformed tool input is an error, not a crash', async () => {
  const r = await executeTool(ctx(), 'lookupOrder', 'nonsense');
  assert.equal(r.isError, true);
  const u = await executeTool(ctx(), 'deleteAllOrders', {});
  assert.equal(u.isError, true);
});
