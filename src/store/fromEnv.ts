// Pick the store for live use (chat, server). Evals always use MockStore.
import { MockStore, type StoreAdapter } from './store.ts';
import { ShopifyStore, shopifyConfigFromEnv } from './shopify.ts';

export function createStore(kind: string | undefined): StoreAdapter {
  if (!kind || kind === 'mock') return new MockStore();
  if (kind === 'shopify') return new ShopifyStore(shopifyConfigFromEnv());
  throw new Error(`Unknown --store "${kind}". Use mock or shopify.`);
}
