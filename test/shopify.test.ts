// ShopifyStore against a fake Shopify Admin API (token endpoint + GraphQL):
// auth caching and refresh, data mapping, and the real tools and guards on top.
// No Shopify account needed; the live check runs later with `npm run shopify-check`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ShopifyStore, mapDisplayStatus, returnReasonHandle } from '../src/store/shopify.ts';
import { executeTool, newState, type ToolContext } from '../src/agent/tools.ts';

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const money = (a: number) => ({ shopMoney: { amount: String(a) } });
const MAYA = { id: 'gid://shopify/Customer/1', firstName: 'Maya', lastName: 'Chen', defaultEmailAddress: { emailAddress: 'maya.chen@example.com' }, defaultPhoneNumber: { phoneNumber: '+15550100101' } };

function order(name: string, opts: { displayStatus?: string; deliveredDaysAgo?: number; sku?: string; price?: number; fulfilled?: boolean } = {}) {
  const sku = opts.sku ?? 'HOOD-TRAIL';
  return {
    id: `gid://shopify/Order/${name.replace('#', '')}`,
    name,
    createdAt: daysAgo(12),
    cancelledAt: null,
    displayFulfillmentStatus: opts.fulfilled === false ? 'UNFULFILLED' : 'FULFILLED',
    email: 'maya.chen@example.com',
    phone: null,
    note: null,
    discountCodes: [],
    customer: MAYA,
    totalDiscountsSet: money(0),
    totalShippingPriceSet: money(0),
    totalPriceSet: money(opts.price ?? 68),
    shippingAddress: { city: 'Portland', provinceCode: 'OR', countryCodeV2: 'US' },
    lineItems: { nodes: [{ id: 'gid://shopify/LineItem/11', sku, title: 'Trail Hoodie', quantity: 1, originalUnitPriceSet: money(opts.price ?? 68) }] },
    fulfillments:
      opts.fulfilled === false
        ? []
        : [
            {
              createdAt: daysAgo(10),
              displayStatus: opts.displayStatus ?? 'IN_TRANSIT',
              deliveredAt: opts.deliveredDaysAgo !== undefined ? daysAgo(opts.deliveredDaysAgo) : null,
              estimatedDeliveryAt: '2026-11-12T00:00:00Z',
              trackingInfo: [{ company: 'UPS', number: '1Z999', url: null }],
              events: { nodes: [{ status: 'IN_TRANSIT', happenedAt: daysAgo(2), message: 'Arrived at facility', city: 'Medford', province: 'OR' }] },
              fulfillmentLineItems: { nodes: [{ id: 'gid://shopify/FulfillmentLineItem/99', quantity: 1, lineItem: { id: 'gid://shopify/LineItem/11', sku } }] },
            },
          ],
  };
}

function fakeShopify(opts: { expiresIn?: number; firstGraphqlStatus?: number } = {}) {
  const calls = { token: 0, graphql: 0, returnInputs: [] as any[] };
  const orders: Record<string, any> = {
    '1042': order('#1042'),
    '1001': order('#1001', { displayStatus: 'DELIVERED', deliveredDaysAgo: 9, sku: 'JKT-RAIN', price: 129 }),
    '1002': order('#1002', { displayStatus: 'DELIVERED', deliveredDaysAgo: 5, sku: 'SOCK-WOOL', price: 24 }),
    '1006': order('#1006', { fulfilled: false, sku: 'MUG-SET', price: 45 }),
  };
  let failNext = opts.firstGraphqlStatus;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/admin/oauth/access_token') {
        calls.token++;
        const p = new URLSearchParams(raw);
        if (p.get('grant_type') !== 'client_credentials' || p.get('client_secret') !== 'secret') return json(400, { error: 'invalid_client' });
        return json(200, { access_token: `tok${calls.token}`, scope: 'read_orders', expires_in: opts.expiresIn ?? 86399 });
      }
      if (req.url !== '/admin/api/2026-10/graphql.json') return json(404, {});
      calls.graphql++;
      if (failNext) {
        const s = failNext;
        failNext = undefined;
        return json(s, { errors: 'Invalid API key or access token' });
      }
      if (!String(req.headers['x-shopify-access-token'] ?? '').startsWith('tok')) return json(401, { errors: 'unauthorized' });
      const { query, variables } = JSON.parse(raw);
      const op = query.match(/(?:query|mutation) (\w+)/)?.[1];
      switch (op) {
        case 'RelayOrderByName': {
          const n = String(variables.q).replace('name:', '');
          return json(200, { data: { orders: { nodes: orders[n] ? [orders[n]] : [] } } });
        }
        case 'RelayCustomerByContact': {
          const hit = /maya\.chen@example\.com|\+15550100101/.test(variables.q);
          return json(200, { data: { customers: { nodes: hit ? [MAYA] : [] } } });
        }
        case 'RelayOrdersByCustomer':
          return json(200, { data: { orders: { nodes: variables.q === 'customer_id:1' ? Object.values(orders) : [] } } });
        case 'RelayVariantBySku': {
          const sku = String(variables.q).replace(/^sku:"|"$/g, '');
          const tags = sku === 'SOCK-WOOL' ? ['final-sale'] : [];
          return json(200, { data: { productVariants: { nodes: [{ sku, price: '24.00', product: { title: sku, tags } }] } } });
        }
        case 'RelayDiscountByCode':
          return json(200, {
            data: {
              codeDiscountNodeByCode:
                variables.code === 'WELCOME10'
                  ? { codeDiscount: { __typename: 'DiscountCodeBasic', title: 'Welcome', status: 'ACTIVE', startsAt: '2026-01-01T00:00:00Z', endsAt: null, tags: [], customerGets: { value: { __typename: 'DiscountPercentage', percentage: 0.1 } }, minimumRequirement: null } }
                  : null,
            },
          });
        case 'RelayReturnReasons':
          return json(200, {
            data: { returnReasonDefinitions: { nodes: ['too-small', 'too-big', 'damaged-or-defective', 'changed-my-mind', 'other-reason'].map((h) => ({ id: `gid://shopify/ReturnReasonDefinition/${h}`, handle: h, deleted: false })) } },
          });
        case 'RelayReturnCreate':
          // Like real Shopify (found in the live test): a reason is required.
          if (!variables.returnInput.returnLineItems.every((l: any) => l.returnReasonDefinitionId)) {
            return json(200, { data: { returnCreate: { return: null, userErrors: [{ field: ['returnLineItems'], message: 'Either return reason or return reason definition must be provided' }] } } });
          }
          calls.returnInputs.push(variables.returnInput);
          return json(200, { data: { returnCreate: { return: { id: 'gid://shopify/Return/5', name: '#1001-R1', status: 'OPEN' }, userErrors: [] } } });
        default:
          return json(200, { errors: [{ message: `unknown operation ${op}` }] });
      }
    });
  });
  return new Promise<{ store: ShopifyStore; calls: typeof calls; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const store = new ShopifyStore({ shopDomain: 'test.myshopify.com', clientId: 'id', clientSecret: 'secret', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
      resolve({ store, calls, close: () => server.close() });
    }),
  );
}

const ctx = (store: ShopifyStore, contact = '+15550100101'): ToolContext => ({
  store,
  state: newState(),
  sender: { channel: 'sms', contact },
  escalate: async () => 'esc_test',
});
const run = async (c: ToolContext, name: string, input: object) => (await executeTool(c, name, input)).content as any;

test('token: fetched once, reused, and refreshed after a 401', async () => {
  const s = await fakeShopify({ firstGraphqlStatus: 401 });
  await s.store.getOrder('1042');
  await s.store.getOrder('1042');
  s.close();
  assert.equal(s.calls.token, 2, 'one initial token plus one refresh after the 401');
  assert.equal(s.calls.graphql, 3);
});

test('token: refreshed when close to expiry', async () => {
  const s = await fakeShopify({ expiresIn: 30 }); // inside the 60 s safety margin
  await s.store.getOrder('1042');
  await s.store.getOrder('1042');
  s.close();
  assert.equal(s.calls.token, 2);
});

test('orders map to Relay\'s model: number, status, shipments, tracking, owner', async () => {
  const s = await fakeShopify();
  const o = (await s.store.getOrder('#1042'))!;
  const owner = await s.store.getCustomer(o.customerId);
  s.close();
  assert.equal(o.number, '1042');
  assert.equal(o.status, 'fulfilled');
  assert.equal(o.shipments[0].status, 'in_transit');
  assert.equal(o.shipments[0].carrier, 'UPS');
  assert.equal(o.shipments[0].trackingNumber, '1Z999');
  assert.equal(o.shipments[0].estimatedDelivery, '2026-11-12');
  assert.deepEqual(o.shipments[0].skus, ['HOOD-TRAIL']);
  assert.equal(owner?.email, 'maya.chen@example.com');
  assert.equal(mapDisplayStatus('OUT_FOR_DELIVERY'), 'out_for_delivery');
  assert.equal(mapDisplayStatus('DELAYED'), 'exception');
  assert.equal(mapDisplayStatus(null), 'label_created');
});

test('the real tools and guards run on Shopify data', async () => {
  const s = await fakeShopify();
  const mine = ctx(s.store);
  assert.equal((await run(mine, 'lookupOrder', { orderNumber: '1042' })).verified, true);
  assert.equal((await run(ctx(s.store, '+15550199999'), 'lookupOrder', { orderNumber: '1042' })).verified, false, 'a stranger sees nothing');
  assert.equal((await run(mine, 'lookupOrder', { orderNumber: '99999' })).found, false);
  const listed = await run(ctx(s.store, 'maya.chen@example.com'), 'lookupOrder', {});
  assert.equal(listed.orders.length, 4);
  const track = await run(mine, 'getTrackingStatus', { orderNumber: '1042' });
  assert.equal(track.shipments[0].latestEvents[0].status, 'Arrived at facility');

  // Return: eligibility in code, then returnCreate with the fulfillment line item.
  assert.equal((await run(mine, 'startReturn', { orderNumber: '1001', sku: 'JKT-RAIN', reason: 'fit' })).error, 'eligibility_not_checked');
  const e = await run(mine, 'checkReturnEligibility', { orderNumber: '1001', sku: 'JKT-RAIN' });
  assert.equal(e.eligible, true);
  assert.equal(e.daysSinceDelivery, 9);
  const r = await run(mine, 'startReturn', { orderNumber: '1001', sku: 'JKT-RAIN', reason: 'fit' });
  assert.equal(r.ok, true);
  assert.equal(r.labelEmailed, false, 'honest: Shopify does not email a label automatically');
  assert.match(r.nextSteps, /teammate will email the prepaid return label/);
  assert.deepEqual(s.calls.returnInputs[0], {
    orderId: 'gid://shopify/Order/1001',
    notifyCustomer: false,
    returnLineItems: [{ fulfillmentLineItemId: 'gid://shopify/FulfillmentLineItem/99', quantity: 1, returnReasonDefinitionId: 'gid://shopify/ReturnReasonDefinition/other-reason', returnReasonNote: 'fit' }],
  });
  assert.equal(returnReasonHandle('too small'), 'too-small');
  assert.equal(returnReasonHandle('it leaks'), 'damaged-or-defective');
  assert.equal(returnReasonHandle('too warm'), 'changed-my-mind');
  assert.equal(returnReasonHandle("doesn't fit"), 'other-reason');

  // Tags drive policy: final-sale product.
  const socks = await run(mine, 'checkReturnEligibility', { orderNumber: '1002', sku: 'SOCK-WOOL' });
  assert.ok(socks.reasons.includes('final_sale'));

  // Discounts: code read from Shopify (0.1 -> 10%), but placed orders cannot be edited by the agent.
  assert.equal((await s.store.getDiscountCode('WELCOME10'))?.value, 10);
  const d = await run(mine, 'applyDiscountCode', { orderNumber: '1006', code: 'WELCOME10' });
  assert.equal(d.error, 'not_supported');
  assert.equal((await run(mine, 'applyDiscountCode', { orderNumber: '1006', code: 'FAKE100' })).error, 'code_not_found');
  s.close();
});
