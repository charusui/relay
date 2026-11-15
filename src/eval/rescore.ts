// Re-grade a finished run's saved conversations with the CURRENT grader.
// No model calls, no cost: use it after a grader change, so every past run is
// held to the same checks. Reports what changed, case by case.
//
//   npm run rescore -- <runId> [<runId> ...]

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { cases } from './cases.ts';
import { fmtRatio, summarize, writeReport } from './report.ts';
import { loadRun, runDir } from './runner.ts';
import { scoreCase } from './score.ts';

const runIds = process.argv.slice(2);
if (!runIds.length) {
  console.error('Usage: npm run rescore -- <runId> [<runId> ...]');
  process.exit(1);
}

for (const runId of runIds) {
  const { meta, results } = loadRun(runId);
  const before = summarize(results);
  const changed: string[] = [];
  for (const r of results) {
    if (!r.scores) continue;
    const c = cases.find((x) => x.id === r.caseId);
    if (!c) continue;
    const s = scoreCase(c, r.turns);
    if (s.resolution !== r.scores.resolution || s.toolUse !== r.scores.toolUse) {
      changed.push(`${r.caseId}#${r.repeat}: resolution ${r.scores.resolution}->${s.resolution}, tools ${r.scores.toolUse}->${s.toolUse}${s.failures.length ? ` (${s.failures.join('; ')})` : ''}`);
    }
    r.scores = s;
    appendFileSync(path.join(runDir(runId), 'results.jsonl'), `${JSON.stringify(r)}\n`); // later lines win
  }
  const fresh = loadRun(runId);
  writeReport(fresh.meta, fresh.results);
  const after = summarize(fresh.results);
  console.log(`\n${runId}${meta.offline ? ' (SIMULATED)' : ''}`);
  console.log(`  resolution ${fmtRatio(before.resolution)} -> ${fmtRatio(after.resolution)}; tool use ${fmtRatio(before.toolUse)} -> ${fmtRatio(after.toolUse)}`);
  for (const c of changed) console.log(`  changed ${c}`);
  if (!changed.length) console.log('  no case changed');
}
