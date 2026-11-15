// Re-run only the AI judge on a finished run's saved conversations. Use it
// when the judge or its scope changes: the agent is not called again, so it
// costs judge requests only and the conversations stay exactly as they were.
//
//   npm run rejudge -- <runId>                  judge every conversation
//   npm run rejudge -- <runId> --scope marked   only cases marked judge: true

import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv } from '../config.ts';
import { describeModelError } from '../agent/model.ts';
import { createJudgeModel } from '../agent/providers.ts';
import { cases } from './cases.ts';
import { judgeConversation } from './judge.ts';
import { fmtRatio, summarize, writeReport } from './report.ts';
import { loadRun, runDir } from './runner.ts';

loadEnv();
const { values, positionals } = parseArgs({ allowPositionals: true, options: { scope: { type: 'string', default: 'all' } } });
const runId = positionals[0];
if (!runId) {
  console.error('Usage: npm run rejudge -- <runId> [--scope all|marked]');
  process.exit(1);
}

try {
  const { meta, results } = loadRun(runId);
  if (meta.offline) throw new Error('This run is SIMULATED (offline stub); there is nothing real to judge.');
  const judge = createJudgeModel();
  if (judge.provider === meta.provider) console.warn(`Note: judge and agent share a provider (${judge.provider}).`);
  const scope = values.scope === 'marked' ? 'marked' : 'all';
  const todo = results.filter((r) => r.scores && (scope === 'all' || cases.find((c) => c.id === r.caseId)?.expect.judge));
  console.log(`Re-judging ${todo.length} conversation(s) of ${runId} with ${judge.provider}:${judge.modelId}...`);
  let n = 0;
  for (const r of todo) {
    r.judge = await judgeConversation(judge, r.turns);
    appendFileSync(path.join(runDir(runId), 'results.jsonl'), `${JSON.stringify(r)}\n`); // later lines win
    n++;
    const j = r.judge;
    console.log(`  [${n}/${todo.length}] ${r.caseId}  ${j.error ? `judge error: ${j.error}` : `grounded=${j.grounded} tone=${j.toneOk ? 'ok' : 'NOT OK'}${j.unsupportedClaims.length ? `  unsupported: ${j.unsupportedClaims.join(' | ')}` : ''}`}`);
  }
  meta.judge = `${judge.provider}:${judge.modelId}`;
  meta.judgeScope = scope;
  writeFileSync(path.join(runDir(runId), 'meta.json'), JSON.stringify(meta, null, 2));
  const fresh = loadRun(runId);
  const { md } = writeReport(fresh.meta, fresh.results);
  const s = summarize(fresh.results);
  console.log(`\nGroundedness ${fmtRatio(s.groundedness)}, tone ok ${fmtRatio(s.toneOk)}, judge errors ${s.judgeErrors}.\nReport: ${md}`);
} catch (err) {
  console.error(`Re-judge failed: ${describeModelError(err)}`);
  process.exitCode = 1;
}
