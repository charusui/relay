// Daily synthetic check (Vercel Cron, see vercel.json; the free plan allows one run a day).
// Vercel calls it with "Authorization: Bearer <CRON_SECRET>". Anyone else gets 401, so
// nobody outside can spend the model quota through this route.

import { monitoringNotifierFromEnv } from '../../../../src/alerts/slack.ts';
import { evaluateAlerts } from '../../../../src/monitor/alerts.ts';
import { runSyntheticCheck } from '../../../../src/monitor/synthetic.ts';
import { relay } from '../../../lib/relay.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Run next to the Neon database (AWS us-east-1); the account default region is Singapore.
export const preferredRegion = 'iad1';
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: 'CRON_SECRET is not set' }, { status: 503 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const { db, deps } = await relay();
  const notify = monitoringNotifierFromEnv();
  // Synthetic checks always run on a fresh mock store per case, whatever store live SMS uses.
  const run = await runSyntheticCheck({ db, model: deps.model, variant: deps.variant }, notify);
  const alerts = await evaluateAlerts(db, notify);
  return Response.json({ passed: run.passed, total: run.total, errors: run.errors, stoppedForQuota: run.stoppedForQuota, results: run.results, alerts });
}
