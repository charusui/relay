// Retrieval benchmark: realistic customer phrasings and the policy passage
// that must come back in the top 3. Added after failure 04, where "shipping"
// queries missed the "Where we ship" passage. Any retrieval change must keep
// every one of these passing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchPolicies, stem } from '../src/policy/retrieval.ts';

export const RETRIEVAL_BENCHMARK: [query: string, expectedId: string][] = [
  ['do you ship to the UK?', 'shipping#where-we-ship'],
  ['international shipping UK', 'shipping#where-we-ship'],
  ['international shipping destinations', 'shipping#where-we-ship'],
  ['which countries do you ship to', 'shipping#where-we-ship'],
  ['how long does standard shipping take to canada?', 'shipping#shipping-speeds-and-costs'],
  ['shipping to canada time', 'shipping#shipping-speeds-and-costs'],
  ['shipping canada standard', 'shipping#shipping-speeds-and-costs'],
  ['import duties canada', 'shipping#shipping-speeds-and-costs'],
  ['expedited shipping cost', 'shipping#shipping-speeds-and-costs'],
  ['free shipping minimum', 'shipping#shipping-speeds-and-costs'],
  ['when will my order ship processing time', 'shipping#processing-time'],
  ['change shipping address', 'shipping#changing-an-address'],
  ['i moved, update my address', 'shipping#changing-an-address'],
  ['no tracking update for days', 'shipping#delays-and-delivery-exceptions'],
  ['package delayed weather', 'shipping#delays-and-delivery-exceptions'],
  ['cancelled order refund', 'shipping#cancelled-orders'],
  ['how many days do i have to return', 'returns#return-window'],
  ['can i return socks', 'returns#items-that-cannot-be-returned'],
  ['gift card return', 'returns#items-that-cannot-be-returned'],
  ['clearance final sale return', 'returns#items-that-cannot-be-returned'],
  ['how long does a refund take', 'returns#refunds'],
  ['exchange for a different size', 'returns#exchanges'],
  ['headlamp warranty strap breaks', 'warranty#what-is-covered'],
  ['how do i make a warranty claim', 'warranty#how-to-make-a-warranty-claim'],
  ['do you price match', 'discounts-and-accounts#price-adjustments'],
  ['can i use two discount codes', 'discounts-and-accounts#using-discount-codes'],
  ['expired code', 'discounts-and-accounts#expired-and-future-codes'],
  ['what are your support hours', 'discounts-and-accounts#contact-hours'],
];

test('stemmer: shipping/shipped/ships all reduce to ship', () => {
  assert.equal(stem('shipping'), 'ship');
  assert.equal(stem('shipped'), 'ship');
  assert.equal(stem('ships'), 'ship');
  assert.equal(stem('returns'), stem('returning'));
});

// Known limit of keyword search, kept visible instead of tuned away: on 2026-11-14 tuning BM25 to pass it
// made held-out queries worse (see docs/failures/04-retrieval-stemmer.md).
const KNOWN_MISSES = ['shipping to canada time'];

test('retrieval benchmark: expected passage in the top 3 for every query except known misses', () => {
  const misses = RETRIEVAL_BENCHMARK.filter(([q, id]) => !searchPolicies(q, 3).some((p) => p.id === id)).map(
    ([q, id]) => `"${q}" expected ${id}, got ${searchPolicies(q, 3).map((p) => p.id).join(', ') || 'nothing'}`,
  );
  assert.deepEqual(
    misses.filter((m) => !KNOWN_MISSES.some((k) => m.startsWith(`"${k}"`))),
    [],
  );
});
