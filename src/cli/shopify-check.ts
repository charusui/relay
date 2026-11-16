// Check the Shopify connection: gets a token, reads the store's latest orders,
// and prints them the way Relay sees them. Read-only: it changes nothing.
//
//   npm run shopify-check

import { loadEnv } from '../config.ts';
import { ShopifyStore, shopifyConfigFromEnv } from '../store/shopify.ts';
import { mapOrder } from '../store/shopify.ts';

loadEnv();
try {
  const cfg = shopifyConfigFromEnv();
  const store = new ShopifyStore(cfg);
  const data = await store.graphql(
    `query RelayCheck { shop { name myshopifyDomain } orders(first: 5, sortKey: CREATED_AT, reverse: true) { nodes { name createdAt displayFulfillmentStatus cancelledAt
      lineItems(first: 5) { nodes { sku title quantity originalUnitPriceSet { shopMoney { amount } } } }
      fulfillments(first: 3) { createdAt displayStatus deliveredAt estimatedDeliveryAt trackingInfo(first: 1) { company number } fulfillmentLineItems(first: 5) { nodes { lineItem { sku } } } } } } }`,
  );
  console.log(`Connected to ${data.shop.name} (${data.shop.myshopifyDomain}), API ${cfg.apiVersion ?? '2026-10'}.`);
  if (!data.orders.nodes.length) console.log('No orders yet. Create a few test orders in the Shopify admin, then run this again.');
  for (const raw of data.orders.nodes) {
    const o = mapOrder({ ...raw, customer: null, totalDiscountsSet: null, totalShippingPriceSet: null, totalPriceSet: null, shippingAddress: null });
    const skus = o.lineItems.map((l) => `${l.title}${l.sku ? ` (${l.sku})` : ' (NO SKU: set one, Relay matches items by SKU)'}`).join(', ');
    const ship = o.shipments.map((s) => `${s.status}${s.trackingNumber ? ` ${s.carrier} ${s.trackingNumber}` : ''}${s.deliveredAt ? `, delivered ${s.deliveredAt.slice(0, 10)}` : ''}`).join('; ') || 'not shipped';
    console.log(`  #${o.number}  ${o.status}  ${skus}  ->  ${ship}`);
  }
} catch (err) {
  console.error(`Shopify check failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
