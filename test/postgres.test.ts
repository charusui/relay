// The hosted-Postgres path (DATABASE_URL, node-postgres), exercised for real:
// PGlite served over TCP by pglite-socket, so the same driver code that talks
// to Neon in production runs here with no account and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { handleInbound } from '../src/handler.ts';
import { OfflineModel } from '../src/agent/offlineModel.ts';
import { getVariant } from '../src/agent/variants.ts';
import { RelayDb } from '../src/db/db.ts';
import { MockStore } from '../src/store/store.ts';

test('node-postgres path: schema, handler, monitoring tables', async () => {
  const pglite = await PGlite.create();
  const port = 55000 + (process.pid % 1000);
  const server = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1' });
  await server.start();
  const before = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  try {
    const db = await RelayDb.open('unused-when-database-url-is-set');
    assert.equal(db.kind, 'postgres');

    const deps = { db, store: new MockStore(), model: new OfflineModel(), variant: getVariant('baseline') };
    const live = await handleInbound(deps, { channel: 'sms', from: '+15550100101', text: 'where is #1042' });
    assert.match(live.reply, /UPS/);
    // Synthetic traffic never continues a live thread for the same contact.
    const synth = await handleInbound(deps, { channel: 'sms', from: '+15550100101', text: 'where is #1042', traffic: 'synthetic' });
    assert.notEqual(synth.conversationId, live.conversationId);

    const rows = await db.sql.query<{ traffic: string; n: number }>(`select traffic, count(*)::int as n from conversations group by traffic order by traffic`);
    assert.deepEqual(rows.rows, [{ traffic: 'live', n: 1 }, { traffic: 'synthetic', n: 1 }]);
    const turns = await db.sql.query<{ n: number }>(`select count(*)::int as n from turns`);
    assert.equal(turns.rows[0].n, 2);

    await db.recordFailure({ traffic: 'live', source: 'twilio', message: 'quota' });
    await db.recordAlert({ rule: 'error_rate', message: 'test', value: 0.5, threshold: 0.2, posted: false });
    assert.ok(await db.lastAlertAt('error_rate'));
    assert.equal(await db.lastAlertAt('never_fired'), null);
    await db.close();

    // Opening again re-runs the schema; it must be idempotent on a real server.
    const again = await RelayDb.open('unused');
    const n = await again.sql.query<{ n: number }>(`select count(*)::int as n from conversations`);
    assert.equal(n.rows[0].n, 2);
    await again.close();
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
    await server.stop();
    await pglite.close();
  }
});
