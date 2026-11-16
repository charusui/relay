// ShopifyStore: the StoreAdapter over a real Shopify store's Admin GraphQL API
// (a free Shopify Partner development store is enough). Field names checked
// against the 2026-10 Admin API reference.
//
// Auth (Dev Dashboard apps, 2026): no permanent token. The app's client ID and
// secret are exchanged for an access token that lasts 24 hours (client
// credentials grant); it is cached and refreshed shortly before it expires.
//
// Shopify has no "final sale" or "staff-only code" flags, so Relay reads tags:
//   product tags   final-sale | non-returnable | warranty
//   discount tags  staff-only
//
// Evals always use MockStore (deterministic data). This adapter is for demos
// and for the live chat/server (`--store shopify`).

import { StoreNotSupportedError, normalizeContact, normalizeOrderNumber, type StoreAdapter } from './store.ts';
import type { Customer, DiscountCode, LineItem, Order, Product, ReturnRecord, Shipment } from './types.ts';

export type ShopifyConfig = {
  /** e.g. "pinecrest-dev.myshopify.com" */
  shopDomain: string;
  clientId?: string;
  clientSecret?: string;
  /** Optional fixed Admin API token (older custom apps). Used instead of client credentials when set. */
  accessToken?: string;
  apiVersion?: string;
  storeName?: string;
  /** Tests point this at a fake server. Defaults to https://<shopDomain>. */
  baseUrl?: string;
};

export const SHOPIFY_API_VERSION = '2026-10';

const ORDER_FIELDS = `
  id name createdAt processedAt cancelledAt displayFulfillmentStatus email phone note discountCodes
  customer { id firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
  totalDiscountsSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  totalPriceSet { shopMoney { amount } }
  shippingAddress { city provinceCode countryCodeV2 }
  lineItems(first: 50) { nodes { id sku title quantity originalUnitPriceSet { shopMoney { amount } } } }
  fulfillments(first: 10) {
    createdAt displayStatus deliveredAt estimatedDeliveryAt
    trackingInfo(first: 1) { company number url }
    events(first: 10) { nodes { status happenedAt message city province } }
    fulfillmentLineItems(first: 50) { nodes { id quantity lineItem { id sku } } }
  }`;

const Q_ORDER_BY_NAME = `query RelayOrderByName($q: String!) { orders(first: 1, query: $q) { nodes { ${ORDER_FIELDS} } } }`;
const Q_ORDERS_BY_CUSTOMER = `query RelayOrdersByCustomer($q: String!) { orders(first: 10, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`;
const CUSTOMER_FIELDS = 'id firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }';
const Q_CUSTOMER_BY_CONTACT = `query RelayCustomerByContact($q: String!) { customers(first: 1, query: $q) { nodes { ${CUSTOMER_FIELDS} } } }`;
const Q_CUSTOMER = `query RelayCustomer($id: ID!) { customer(id: $id) { ${CUSTOMER_FIELDS} } }`;
const Q_VARIANT_BY_SKU = `query RelayVariantBySku($q: String!) { productVariants(first: 1, query: $q) { nodes { sku price product { title tags } } } }`;
const Q_DISCOUNT = `query RelayDiscountByCode($code: String!) {
  codeDiscountNodeByCode(code: $code) {
    codeDiscount {
      __typename
      ... on DiscountCodeBasic {
        title status startsAt endsAt tags
        customerGets { value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount } } } }
        minimumRequirement { __typename ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } } }
      }
    }
  }
}`;
const Q_RETURN_REASONS = `query RelayReturnReasons($handles: [String!]) { returnReasonDefinitions(first: 20, handles: $handles) { nodes { id handle deleted } } }`;

/**
 * Shopify requires a return reason (2026-10: a ReturnReasonDefinition; the old returnReason enum is
 * deprecated). Map the customer's words to one of Shopify's standard reason handles; the exact
 * words always go along as the reason note.
 */
export function returnReasonHandle(reason: string): string {
  const r = reason.toLowerCase();
  if (/too small|small|tight|short/.test(r)) return 'too-small';
  if (/too big|too large|large|loose|long|big/.test(r)) return 'too-big';
  if (/broken|broke|defect|damag|leak|faulty|stopped working|doesn'?t work|ripped|torn/.test(r)) return 'damaged-or-defective';
  if (/wrong item|wrong product|not what i ordered|sent the wrong/.test(r)) return 'received-the-wrong-item';
  if (/not as described|different from|not like the (photo|picture)/.test(r)) return 'item-not-as-described';
  if (/colou?r/.test(r)) return 'color';
  if (/style|look/.test(r)) return 'style';
  if (/changed my mind|don'?t need|do not need|don'?t want|no longer|unwanted|too warm|too hot|never used/.test(r)) return 'changed-my-mind';
  return 'other-reason';
}
const REASON_HANDLES = ['too-small', 'too-big', 'damaged-or-defective', 'received-the-wrong-item', 'item-not-as-described', 'color', 'style', 'changed-my-mind', 'other-reason'];

const M_RETURN_CREATE = `mutation RelayReturnCreate($returnInput: ReturnInput!) {
  returnCreate(returnInput: $returnInput) { return { id name status } userErrors { field message } }
}`;

const num = (m: { shopMoney?: { amount?: string | number } } | null | undefined) => Number(m?.shopMoney?.amount ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
const legacyId = (gid: string) => gid.split('/').pop() ?? gid;
const quote = (s: string) => `"${s.replace(/["\\]/g, '')}"`;

/** Shopify's per-fulfillment display status, reduced to Relay's five shipment states. */
export function mapDisplayStatus(s: string | null | undefined): Shipment['status'] {
  switch (s) {
    case 'DELIVERED':
      return 'delivered';
    case 'OUT_FOR_DELIVERY':
      return 'out_for_delivery';
    case 'IN_TRANSIT':
    case 'CARRIER_PICKED_UP':
    case 'CONFIRMED':
    case 'PICKED_UP':
      return 'in_transit';
    case 'ATTEMPTED_DELIVERY':
    case 'DELAYED':
    case 'FAILURE':
    case 'NOT_DELIVERED':
    case 'CANCELED':
    case 'LABEL_VOIDED':
      return 'exception';
    default:
      return 'label_created'; // LABEL_PRINTED, LABEL_PURCHASED, FULFILLED, MARKED_AS_FULFILLED, SUBMITTED, READY_FOR_PICKUP, null
  }
}

function mapCustomer(c: any): Customer | undefined {
  if (!c) return undefined;
  return {
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Customer',
    email: c.defaultEmailAddress?.emailAddress?.toLowerCase() ?? undefined,
    phone: c.defaultPhoneNumber?.phoneNumber ?? undefined,
  };
}

export function mapOrder(o: any): Order {
  const lineItems: LineItem[] = (o.lineItems?.nodes ?? []).map((li: any) => ({
    sku: String(li.sku ?? '').toUpperCase(),
    title: li.title,
    quantity: li.quantity,
    unitPrice: num(li.originalUnitPriceSet),
  }));
  const subtotal = round2(lineItems.reduce((s, li) => s + li.unitPrice * li.quantity, 0));
  const shipments: Shipment[] = (o.fulfillments ?? []).map((f: any) => {
    const t = f.trackingInfo?.[0];
    return {
      skus: (f.fulfillmentLineItems?.nodes ?? []).map((n: any) => String(n.lineItem?.sku ?? '').toUpperCase()),
      carrier: t?.company ?? 'Carrier',
      trackingNumber: t?.number ?? '',
      status: mapDisplayStatus(f.displayStatus),
      // The carrier's first scan is when it really shipped; the fulfillment record may be created later.
      shippedAt: (f.events?.nodes ?? []).map((e: any) => e.happenedAt).filter(Boolean).sort()[0] ?? f.createdAt,
      estimatedDelivery: f.estimatedDeliveryAt?.slice(0, 10) ?? undefined,
      deliveredAt: f.deliveredAt ?? undefined,
      events: (f.events?.nodes ?? []).map((e: any) => ({
        at: e.happenedAt,
        status: e.message || String(e.status ?? '').replace(/_/g, ' ').toLowerCase(),
        location: [e.city, e.province].filter(Boolean).join(', ') || undefined,
      })),
    };
  });
  const status: Order['status'] = o.cancelledAt
    ? 'cancelled'
    : o.displayFulfillmentStatus === 'FULFILLED'
      ? 'fulfilled'
      : o.displayFulfillmentStatus === 'PARTIALLY_FULFILLED'
        ? 'partially_fulfilled'
        : 'unfulfilled';
  return {
    number: normalizeOrderNumber(o.name),
    customerId: o.customer?.id ?? `guest:${o.email ?? o.phone ?? o.id}`,
    // processedAt is the order date shown to merchants (imported/backdated orders differ from createdAt).
    placedAt: o.processedAt ?? o.createdAt,
    status,
    lineItems,
    subtotal,
    discountCode: o.discountCodes?.[0] ?? undefined,
    discountAmount: num(o.totalDiscountsSet),
    shipping: num(o.totalShippingPriceSet),
    total: num(o.totalPriceSet),
    shipments,
    note: o.note ?? undefined,
    cancelledAt: o.cancelledAt ?? undefined,
    shippingAddress: { city: o.shippingAddress?.city ?? '', region: o.shippingAddress?.provinceCode ?? '', country: o.shippingAddress?.countryCodeV2 ?? '' },
  };
}

export class ShopifyStore implements StoreAdapter {
  readonly storeName: string;
  private base: string;
  private version: string;
  private token?: { value: string; expiresAt: number };
  private customers = new Map<string, Customer>();
  /** Raw orders by number: the fulfillment line item ids are needed to open returns. */
  private rawOrders = new Map<string, any>();
  private products = new Map<string, Product | null>();

  constructor(private cfg: ShopifyConfig) {
    if (!cfg.accessToken && !(cfg.clientId && cfg.clientSecret)) {
      throw new Error('Shopify needs SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (Dev Dashboard app), or SHOPIFY_ADMIN_TOKEN.');
    }
    this.base = (cfg.baseUrl ?? `https://${cfg.shopDomain}`).replace(/\/$/, '');
    this.version = cfg.apiVersion ?? SHOPIFY_API_VERSION;
    this.storeName = cfg.storeName ?? 'Pinecrest Supply';
  }

  now() {
    return new Date();
  }

  /** Client credentials grant: a token valid for about 24 hours, refreshed a minute early. */
  private async accessToken(forceRefresh = false): Promise<string> {
    if (this.cfg.accessToken) return this.cfg.accessToken;
    if (!forceRefresh && this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await fetch(`${this.base}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cfg.clientId!, client_secret: this.cfg.clientSecret! }).toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Shopify token request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    this.token = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async graphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${this.base}/admin/api/${this.version}/graphql.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-access-token': await this.accessToken(attempt > 1 && this.lastWas401) },
        body: JSON.stringify({ query, variables }),
      });
      this.lastWas401 = res.status === 401;
      if (res.status === 401 && attempt === 1 && !this.cfg.accessToken) continue; // token revoked or expired early: refresh once
      const text = await res.text();
      if (res.status === 429 && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      if (!res.ok) throw new Error(`Shopify GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
      const body = JSON.parse(text);
      if (body.errors?.length) {
        if (body.errors.some((e: any) => e.extensions?.code === 'THROTTLED') && attempt < 4) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }
        const msg = body.errors.map((e: any) => e.message).join('; ');
        // Only blame protected customer data when Shopify says so; a missing scope also reads "Access denied".
        if (/protected customer data|not approved to access/i.test(msg) && !/access scope/i.test(msg)) {
          throw new Error(
            `Shopify hid protected customer data (name, email, phone or address), which Relay needs to check who owns an order. In the app's settings, select those protected customer data fields (no review is needed for apps installed only on development stores). Shopify said: ${msg.slice(0, 200)}`,
          );
        }
        throw new Error(`Shopify GraphQL error: ${msg.slice(0, 300)}`);
      }
      return body.data as T;
    }
  }
  private lastWas401 = false;

  private remember(raw: any): Order {
    const order = mapOrder(raw);
    this.rawOrders.set(order.number, raw);
    const c = mapCustomer(raw.customer);
    if (c) {
      // Order-level contact is what the customer typed at checkout; use it when the profile has none.
      this.customers.set(c.id, { ...c, email: c.email ?? raw.email?.toLowerCase() ?? undefined, phone: c.phone ?? raw.phone ?? undefined });
    } else {
      this.customers.set(order.customerId, { id: order.customerId, name: 'Customer', email: raw.email?.toLowerCase() ?? undefined, phone: raw.phone ?? undefined });
    }
    return order;
  }

  async getOrder(number: string) {
    const n = normalizeOrderNumber(number);
    if (!/^[A-Za-z0-9-]+$/.test(n)) return undefined;
    const data = await this.graphql(Q_ORDER_BY_NAME, { q: `name:${n}` });
    const raw = data.orders.nodes.find((o: any) => normalizeOrderNumber(o.name) === n);
    return raw ? this.remember(raw) : undefined;
  }

  async getCustomer(id: string) {
    if (this.customers.has(id)) return this.customers.get(id);
    if (!id.startsWith('gid://')) return undefined;
    const data = await this.graphql(Q_CUSTOMER, { id });
    const c = mapCustomer(data.customer);
    if (c) this.customers.set(c.id, c);
    return c;
  }

  async findCustomerByContact(contact: string) {
    const c = normalizeContact(contact);
    const data = await this.graphql(Q_CUSTOMER_BY_CONTACT, { q: c.includes('@') ? `email:${quote(c)}` : `phone:${quote(c)}` });
    const found = mapCustomer(data.customers.nodes[0]);
    if (found) this.customers.set(found.id, found);
    return found;
  }

  async ordersForCustomer(customerId: string) {
    if (!customerId.startsWith('gid://')) return [];
    const data = await this.graphql(Q_ORDERS_BY_CUSTOMER, { q: `customer_id:${legacyId(customerId)}` });
    return data.orders.nodes.map((o: any) => this.remember(o));
  }

  async getProduct(sku: string) {
    const key = sku.trim().toUpperCase();
    if (this.products.has(key)) return this.products.get(key) ?? undefined;
    const data = await this.graphql(Q_VARIANT_BY_SKU, { q: `sku:${quote(sku.trim())}` });
    const v = data.productVariants.nodes[0];
    const tags: string[] = (v?.product?.tags ?? []).map((t: string) => t.toLowerCase());
    const product: Product | null = v
      ? {
          sku: key,
          title: v.product.title,
          price: Number(v.price),
          finalSale: tags.includes('final-sale') || undefined,
          nonReturnable: tags.includes('non-returnable') || undefined,
          warranty: tags.includes('warranty') || undefined,
        }
      : null;
    this.products.set(key, product);
    return product ?? undefined;
  }

  async getDiscountCode(code: string): Promise<DiscountCode | undefined> {
    const data = await this.graphql(Q_DISCOUNT, { code: code.trim() });
    const d = data.codeDiscountNodeByCode?.codeDiscount;
    // Only basic percentage/fixed-amount codes are supported; others are treated as unavailable to the agent.
    if (!d || d.__typename !== 'DiscountCodeBasic') return undefined;
    const value = d.customerGets?.value;
    const pct = value?.__typename === 'DiscountPercentage';
    return {
      code: code.trim().toUpperCase(),
      kind: pct ? 'percent' : 'fixed',
      value: pct ? Math.round(Number(value.percentage) * 10000) / 100 : Number(value?.amount?.amount ?? 0),
      minSubtotal: Number(d.minimumRequirement?.greaterThanOrEqualToSubtotal?.amount ?? 0),
      startsAt: d.startsAt,
      endsAt: d.endsAt ?? '9999-12-31T23:59:59Z',
      staffOnly: (d.tags ?? []).map((t: string) => t.toLowerCase()).includes('staff-only') || undefined,
    };
  }

  private reasonIds?: Map<string, string>;

  /** ID of one of Shopify's standard return reasons, falling back to "other-reason". */
  private async returnReasonId(handle: string): Promise<string> {
    if (!this.reasonIds) {
      const d = await this.graphql(Q_RETURN_REASONS, { handles: REASON_HANDLES });
      this.reasonIds = new Map(d.returnReasonDefinitions.nodes.filter((n: any) => !n.deleted).map((n: any) => [n.handle, n.id]));
    }
    const id = this.reasonIds.get(handle) ?? this.reasonIds.get('other-reason');
    if (!id) throw new StoreNotSupportedError('This store has no return reasons set up, so the return could not be opened. A teammate can help.');
    return id;
  }

  async setOrderDiscount(): Promise<Order> {
    throw new StoreNotSupportedError(
      'On this store, a code cannot be added to an order that has already been placed (Shopify needs an order edit). A teammate can do it: escalate with reason low_confidence if the customer wants the code applied.',
    );
  }

  async createReturn(input: { orderNumber: string; sku: string; reason: string; refundAmount: number }): Promise<ReturnRecord> {
    const n = normalizeOrderNumber(input.orderNumber);
    const raw = this.rawOrders.get(n) ?? (await this.getOrder(n), this.rawOrders.get(n));
    if (!raw) throw new Error(`order ${n} not found`);
    const fli = (raw.fulfillments ?? [])
      .flatMap((f: any) => f.fulfillmentLineItems?.nodes ?? [])
      .find((x: any) => String(x.lineItem?.sku ?? '').toUpperCase() === input.sku.toUpperCase());
    if (!fli) throw new StoreNotSupportedError('That item has no fulfilled shipment to return yet. A teammate can help.');
    const reasonId = await this.returnReasonId(returnReasonHandle(input.reason));
    const data = await this.graphql(M_RETURN_CREATE, {
      returnInput: {
        orderId: raw.id,
        notifyCustomer: false,
        returnLineItems: [{ fulfillmentLineItemId: fli.id, quantity: fli.quantity, returnReasonDefinitionId: reasonId, returnReasonNote: input.reason.slice(0, 255) }],
      },
    });
    const errs = data.returnCreate?.userErrors ?? [];
    if (errs.length) throw new StoreNotSupportedError(`Shopify could not open the return (${errs.map((e: any) => e.message).join('; ')}). A teammate can help.`);
    const ret = data.returnCreate.return;
    return {
      id: ret.name ?? ret.id,
      orderNumber: n,
      sku: input.sku.toUpperCase(),
      reason: input.reason,
      refundAmount: input.refundAmount,
      labelEmailed: false,
      nextSteps: 'Return opened. A teammate will email the prepaid return label within one business day. Refund to the original payment method 5-10 business days after the item reaches the warehouse.',
      createdAt: new Date().toISOString(),
    };
  }
}

/** The store to use outside evals: Shopify when asked for and configured, otherwise the mock. */
export function shopifyConfigFromEnv(): ShopifyConfig {
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN?.trim();
  if (!shopDomain) throw new Error('SHOPIFY_STORE_DOMAIN is not set in relay/.env (e.g. your-store.myshopify.com).');
  return {
    shopDomain,
    clientId: process.env.SHOPIFY_CLIENT_ID?.trim() || undefined,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET?.trim() || undefined,
    accessToken: process.env.SHOPIFY_ADMIN_TOKEN?.trim() || undefined,
    apiVersion: process.env.SHOPIFY_API_VERSION?.trim() || undefined,
    storeName: process.env.SHOPIFY_STORE_NAME?.trim() || undefined,
  };
}
