// Liveness plus a database round trip. Spends no model quota.
import { relay } from '../../lib/relay.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Run next to the Neon database (AWS us-east-1); the account default region is Singapore.
export const preferredRegion = 'iad1';

export async function GET() {
  try {
    const { db, info } = await relay();
    await db.sql.query('select 1'); // warm the connection
    const t0 = performance.now();
    await db.sql.query('select 1');
    const dbRoundTripMs = Math.round((performance.now() - t0) * 10) / 10;
    return Response.json({ ok: true, database: info.database, dbRoundTripMs, region: process.env.VERCEL_REGION ?? 'local', model: info.model, variant: info.variant });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message.slice(0, 200) }, { status: 503 });
  }
}
