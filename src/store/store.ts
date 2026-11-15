import { round2, seedData } from '../../data/seed.ts';
import type { Customer, DiscountCode, Order, Product, ReturnRecord, StoreData } from './types.ts';

/** A store backend cannot do this operation (e.g. adding a code to a placed Shopify order). Tools turn it into a hand-off. */
export class StoreNotSupportedError extends Error {}

/**
 * What Relay needs from a store. MockStore implements it over seeded data;
 * a Shopify Admin API adapter can implement the same interface later without
 * the agent or the eval suite changing.
 */
export interface StoreAdapter {
  readonly storeName: string;
  now(): Date;
  getOrder(number: string): Promise<Order | undefined>;
  getCustomer(id: string): Promise<Customer | undefined>;
  findCustomerByContact(contact: string): Promise<Customer | undefined>;
  ordersForCustomer(customerId: string): Promise<Order[]>;
  getProduct(sku: string): Promise<Product | undefined>;
  getDiscountCode(code: string): Promise<DiscountCode | undefined>;
  /** May throw StoreNotSupportedError. */
  setOrderDiscount(orderNumber: string, code: string, amount: number): Promise<Order>;
  /** May throw StoreNotSupportedError. */
  createReturn(input: { orderNumber: string; sku: string; reason: string; refundAmount: number }): Promise<ReturnRecord>;
}

export function normalizeOrderNumber(raw: string): string {
  return String(raw).trim().replace(/^#/, '').replace(/^order\s*/i, '').trim();
}

export function normalizeContact(raw: string): string {
  const s = String(raw).trim().toLowerCase();
  if (s.includes('@')) return s;
  const digits = s.replace(/[^\d]/g, '');
  // Treat 10-digit US numbers and +1 numbers as the same contact.
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export class MockStore implements StoreAdapter {
  private data: StoreData;

  constructor(data: StoreData = seedData()) {
    this.data = data;
  }

  get storeName() {
    return this.data.storeName;
  }

  now() {
    return new Date(this.data.now);
  }

  async getOrder(number: string) {
    const n = normalizeOrderNumber(number);
    return this.data.orders.find((o) => o.number === n);
  }

  async getCustomer(id: string) {
    return this.data.customers.find((c) => c.id === id);
  }

  async findCustomerByContact(contact: string) {
    const c = normalizeContact(contact);
    return this.data.customers.find((x) => x.email?.toLowerCase() === c || (x.phone && normalizeContact(x.phone) === c));
  }

  async ordersForCustomer(customerId: string) {
    return this.data.orders.filter((o) => o.customerId === customerId);
  }

  async getProduct(sku: string) {
    return this.data.products.find((p) => p.sku === sku.trim().toUpperCase());
  }

  async getDiscountCode(code: string) {
    return this.data.discountCodes.find((d) => d.code === code.trim().toUpperCase());
  }

  async setOrderDiscount(orderNumber: string, code: string, amount: number) {
    const o = await this.getOrder(orderNumber);
    if (!o) throw new Error(`order ${orderNumber} not found`);
    o.discountCode = code;
    o.discountAmount = amount;
    o.total = round2(o.subtotal - amount + o.shipping);
    return o;
  }

  async createReturn(input: { orderNumber: string; sku: string; reason: string; refundAmount: number }) {
    const o = await this.getOrder(input.orderNumber);
    if (!o) throw new Error(`order ${input.orderNumber} not found`);
    const li = o.lineItems.find((l) => l.sku === input.sku);
    if (!li) throw new Error(`line ${input.sku} not on order`);
    const id = `RMA-${o.number}-${this.data.returns.length + 1}`;
    const rec: ReturnRecord = {
      id,
      orderNumber: o.number,
      sku: input.sku,
      reason: input.reason,
      refundAmount: input.refundAmount,
      // Fictional URL: the mock store does not generate real labels.
      labelUrl: `https://returns.pinecrest.example/label/${id}`,
      createdAt: this.now().toISOString(),
    };
    this.data.returns.push(rec);
    li.returnId = id;
    return rec;
  }
}
