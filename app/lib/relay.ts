// Server-side wiring for the Next.js app: one database connection and one set
// of handler dependencies per server instance, built from environment variables.
//
//   DATABASE_URL        hosted Postgres (Neon). Unset: local PGlite in RELAY_DB_DIR (.data/relay-db)
//   RELAY_PROVIDER etc. the agent's model, as in .env.example. RELAY_OFFLINE=1: scripted stand-in (no quota)
//   RELAY_STORE         mock (default) or shopify (the dev store, for live SMS)
//   RELAY_VARIANT       prompt variant (default: DEFAULT_VARIANT)

import { createModel } from '../../src/agent/providers.ts';
import { DEFAULT_VARIANT, getVariant } from '../../src/agent/variants.ts';
import { RelayDb } from '../../src/db/db.ts';
import type { HandlerDeps } from '../../src/handler.ts';
import { createStore } from '../../src/store/fromEnv.ts';

type Relay = { db: RelayDb; deps: HandlerDeps; info: { database: string; model: string; variant: string; store: string } };

const g = globalThis as typeof globalThis & { __relay?: Promise<Relay> };

async function init(): Promise<Relay> {
  const db = await RelayDb.open();
  const offline = process.env.RELAY_OFFLINE === '1';
  const model = createModel({ offline });
  const variant = getVariant(process.env.RELAY_VARIANT?.trim() || DEFAULT_VARIANT);
  const storeKind = process.env.RELAY_STORE?.trim() || 'mock';
  return {
    db,
    deps: { db, model, variant, store: createStore(storeKind) },
    info: {
      database: db.kind === 'postgres' ? 'Postgres (DATABASE_URL)' : 'PGlite (local)',
      model: offline ? 'offline stand-in' : `${model.provider}:${model.modelId}`,
      variant: variant.id,
      store: storeKind === 'shopify' ? 'Shopify dev store' : 'mock store',
    },
  };
}

/** The shared Relay instance. A failed start is not cached, so the next request retries. */
export function relay(): Promise<Relay> {
  if (!g.__relay) {
    g.__relay = init().catch((err) => {
      g.__relay = undefined;
      throw err;
    });
  }
  return g.__relay;
}
