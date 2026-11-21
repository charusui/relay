// Human escalation queue: list open hand-offs with their summaries.
//   npm run queue                 conversations from the simulator / real channels
//   npm run queue -- --evals      include hand-offs created during eval runs
//   npm run queue -- --show <conversation id>   print the full transcript

import { parseArgs } from 'node:util';
import { RelayDb } from '../db/db.ts';
import { cleanHandoffSummary } from '../agent/handoff-summary.ts';

const { values } = parseArgs({ options: { evals: { type: 'boolean', default: false }, show: { type: 'string' } } });
const db = await RelayDb.open();

if (values.show) {
  for (const m of await db.transcript(values.show)) console.log(`${m.role.padEnd(8)} ${m.body}`);
} else {
  const rows = await db.openEscalations(values.evals);
  if (!rows.length) console.log('Human queue is empty.');
  for (const e of rows) {
    console.log(`\n${e.id}  ${e.reason}  (raised by ${e.source})  ${new Date(e.created_at).toISOString()}`);
    console.log(`  ${e.channel} ${e.contact}   conversation ${e.conversation_id}`);
    console.log(`  ${cleanHandoffSummary(e.summary)}`);
  }
}
await db.close();
