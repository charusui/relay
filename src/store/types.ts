// Store data model. Shaped after the parts of the Shopify Admin API that Relay
// needs (orders, line items, fulfilments, discount codes), so a real Shopify
// adapter can implement the same StoreAdapter interface later.

export type Product = {
  sku: string;
  title: string;
  price: number;
  /** Final-sale items can never be returned (clearance, hygiene items). */
  finalSale?: boolean;
  /** Not returnable for another reason (gift cards). */
  nonReturnable?: boolean;
  nonReturnableReason?: string;
  warranty?: boolean;
};

export type Customer = {
  id: string;
  name: string;
  /** Either may be missing on a real store (guest checkout, no phone). */
  email?: string;
  phone?: string;
};

export type TrackingEvent = { at: string; status: string; location?: string };

export type Shipment = {
  /** SKUs in this shipment. */
  skus: string[];
  carrier: string;
  trackingNumber: string;
  status: 'label_created' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception';
  shippedAt: string;
  estimatedDelivery?: string;
  deliveredAt?: string;
  events: TrackingEvent[];
};

export type LineItem = {
  sku: string;
  title: string;
  quantity: number;
  unitPrice: number;
  /** Set once a return has been opened for this line. */
  returnId?: string;
  backorderedUntil?: string;
};

export type OrderStatus = 'unfulfilled' | 'partially_fulfilled' | 'fulfilled' | 'cancelled';

export type Order = {
  number: string; // "1042", no '#'
  customerId: string;
  placedAt: string;
  status: OrderStatus;
  lineItems: LineItem[];
  subtotal: number;
  discountCode?: string;
  discountAmount: number;
  shipping: number;
  total: number;
  shipments: Shipment[];
  /** Free-text note on the order. Untrusted: may contain anything a customer typed at checkout. */
  note?: string;
  cancelledAt?: string;
  shippingAddress: { city: string; region: string; country: string };
};

export type DiscountCode = {
  code: string;
  kind: 'percent' | 'fixed';
  value: number;
  minSubtotal: number;
  startsAt: string;
  endsAt: string;
  /** Internal codes the agent must never apply for a customer. */
  staffOnly?: boolean;
};

export type ReturnRecord = {
  id: string;
  orderNumber: string;
  sku: string;
  reason: string;
  refundAmount: number;
  /** Mock store: a fictional label URL. A real store may not generate labels automatically. */
  labelUrl?: string;
  /** False when the label is not sent automatically (a teammate sends it). Default true. */
  labelEmailed?: boolean;
  /** Customer-facing next steps, when they differ from the default. */
  nextSteps?: string;
  createdAt: string;
};

export type StoreData = {
  storeName: string;
  /** Fixed "today" for the mock store, so return windows and evals are deterministic. */
  now: string;
  products: Product[];
  customers: Customer[];
  orders: Order[];
  discountCodes: DiscountCode[];
  returns: ReturnRecord[];
};
