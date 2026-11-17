// Run the synthetic check (and the alert rules) by hand, against whatever
// database is configured: DATABASE_URL (Neon) or local PGlite.
//
//   npm run synthetic                       real model, 5 dev-split cases (~15 model requests)
//   npm run synthetic -- --offline          scripted stand-in model, no quota (plumbing only)
//   npm run synthetic -- --offline --demo   also send a few demo texts
//   npm run synthetic -- --preview          fill the throwaway preview database (.data/preview-db) offline, for `npm run dev:preview`

import { parseArgs } from 'node:util';
import { loadEnv } from '../config.ts';
import { createModel } from '../agent/providers.ts';
import { DEFAULT_VARIANT, getVariant } from '../agent/variants.ts';
import { describeModelError } from '../agent/model.ts';
import { RelayDb } from '../db/db.ts';
import { handleInbound } from '../handler.ts';
import { MockStore } from '../store/store.ts';
import { monitoringNotifierFromEnv } from '../alerts/slack.ts';
import { evaluateAlerts } from '../monitor/alerts.ts';
import { runSyntheticCheck } from '../monitor/synthetic.ts';

loadEnv();
const { values } = parseArgs({
  options: {
    offline: { type: 'boolean', default: false },
    demo: { type: 'boolean', default: false },
    preview: { type: 'boolean', default: false },
    variant: { type: 'string', default: DEFAULT_VARIANT },
    'no-slack': { type: 'boolean', default: false },
  },
});

if (values.preview) {
  // Offline, demo texts, its own database: never touches the real one or any quota.
  values.offline = true;
  values.demo = true;
  process.env.RELAY_DB_DIR = '.data/preview-db';
  delete process.env.DATABASE_URL;
}
const db = await RelayDb.open();
const model = createModel({ offline: values.offline });
const variant = getVariant(values.variant!);
const notify = values['no-slack'] || values.offline ? undefined : monitoringNotifierFromEnv();
console.log(`Database: ${db.kind === 'postgres' ? 'Postgres (DATABASE_URL)' : `PGlite (${process.env.RELAY_DB_DIR ?? '.data/relay-db'})`}. Model: ${model.offline ? 'OFFLINE stub' : `${model.provider}:${model.modelId}`}. Variant: ${variant.id}.`);

try {
  if (values.demo) {
    const texts: [string, string][] = [
      ['+15550100109', 'where is my order 1015?'],
      ['+15550100102', 'can i return the socks from 1002'],
      ['+15550100108', 'I want to talk to a real person about my tent'],
      ['+15550100104', 'do you ship to canada?'],
    ];
    for (const [from, text] of texts) {
      const r = await handleInbound({ db, store: new MockStore(), model, variant }, { channel: 'sms', from, text, traffic: 'demo' });
      console.log(`  demo ${from}: ${r.reply.slice(0, 90).replace(/\n/g, ' ')}${r.escalation ? `  [handed off: ${r.escalation.reason}]` : ''}`);
    }
  }
  const run = await runSyntheticCheck({ db, model, variant }, notify);
  console.log(`\nSynthetic check: ${run.passed}/${run.total} passed${run.errors ? `, ${run.errors} errored` : ''}${run.stoppedForQuota ? ' (stopped: quota used up)' : ''}`);
  for (const r of run.results) console.log(`  ${r.pass ? 'pass' : 'FAIL'}  ${r.caseId}  ${r.error ?? r.reasons.join('; ')}`);
  const fired = await evaluateAlerts(db, notify);
  console.log(fired.length ? `Alerts fired: ${fired.map((f) => `${f.rule}${f.posted ? ' (sent to Slack)' : ''}`).join(', ')}` : 'No alert rules fired.');
} catch (err) {
  console.error(describeModelError(err));
  process.exitCode = 1;
} finally {
  await db.close();
}
