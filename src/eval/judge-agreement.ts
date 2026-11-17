// Measure the AI judge against the hand check. Re-judges saved conversations in
// memory (the saved runs are never changed) and counts, per judge version:
// hand-found problems the judge caught, the ones it missed, and false alarms.
//
//   npm run judge-agreement -- --version v3-own-rules
//   npm run judge-agreement -- --version v2-context --run <runId> --case inject-02 --repeat 3
//   npm run judge-agreement -- --version v2-context --stored     use the verdicts saved with each run (no requests)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv } from '../config.ts';
import { describeModelError } from '../agent/model.ts';
import { createJudgeModel } from '../agent/providers.ts';
import { JUDGE_VERSIONS, judgeConversation, type JudgeVersion } from './judge.ts';
import { loadRun, type CaseResult } from './runner.ts';
import { buildSystemPrompt, getVariant } from '../agent/variants.ts';

type Labels = { runs: { run: string; handFailed: string[]; source: string; heldOut?: boolean }[] };

export type AgreementRow = { run: string; caseId: string; repeat: number; hand: 'fail' | 'ok'; judge: boolean | null; error?: string; unsupported: string[] };

export function tally(rows: AgreementRow[]) {
  const scored = rows.filter((r) => !r.error);
  const problems = scored.filter((r) => r.hand === 'fail');
  const fine = scored.filter((r) => r.hand === 'ok');
  return {
    conversations: scored.length,
    judgeErrors: rows.length - scored.length,
    caught: problems.filter((r) => r.judge === false).length,
    problems: problems.length,
    falseAlarms: fine.filter((r) => r.judge === false).length,
    fine: fine.length,
    falseAlarmCases: fine.filter((r) => r.judge === false).map((r) => `${r.caseId} (${r.run.slice(0, 13)})`),
    missedCases: problems.filter((r) => r.judge !== false).map((r) => `${r.caseId} (${r.run.slice(0, 13)})`),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('src/eval/judge-agreement.ts');
if (isMain) {
  loadEnv();
  const { values } = parseArgs({
    options: {
      version: { type: 'string', default: 'v3-own-rules' },
      run: { type: 'string' },
      case: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      stored: { type: 'boolean', default: false },
      'held-out': { type: 'boolean', default: false },
    },
  });
  const version = values.version as JudgeVersion;
  if (!JUDGE_VERSIONS.includes(version)) throw new Error(`--version must be one of ${JUDGE_VERSIONS.join(', ')}`);
  const labels: Labels = JSON.parse(readFileSync('data/judge-labels.json', 'utf8'));
  const runs = labels.runs.filter((r) => (values.run ? values.run.split(',').includes(r.run) : values['held-out'] ? r.heldOut : !r.heldOut));
  const caseFilter = values.case?.split(',');
  const repeat = Math.max(1, Number(values.repeat));
  const rows: AgreementRow[] = [];
  try {
    const judge = values.stored ? null : createJudgeModel();
    for (const l of runs) {
      const saved = loadRun(l.run);
      const agentInstructions = buildSystemPrompt(getVariant(saved.meta.variant));
      const latest = new Map<string, CaseResult>();
      for (const r of saved.results) latest.set(`${r.caseId}#${r.repeat}`, r); // later lines win
      for (const r of latest.values()) {
        if (caseFilter && !caseFilter.includes(r.caseId)) continue;
        const hand = l.handFailed.includes(r.caseId) ? 'fail' : 'ok';
        if (!judge) {
          if (r.judge?.version !== version) continue;
          rows.push({ run: l.run, caseId: r.caseId, repeat: 1, hand, judge: r.judge.grounded, error: r.judge.error, unsupported: r.judge.unsupportedClaims });
          continue;
        }
        for (let i = 1; i <= repeat; i++) {
          const v = await judgeConversation(judge, r.turns, { version, agentInstructions });
          rows.push({ run: l.run, caseId: r.caseId, repeat: i, hand, judge: v.grounded, error: v.error, unsupported: v.unsupportedClaims });
          const flag = v.error ? `error: ${v.error}` : v.grounded === false ? `FLAG: ${v.unsupportedClaims.join(' | ')}` : String(v.grounded);
          if (v.grounded === false || hand === 'fail' || v.error) console.log(`  ${l.run.slice(0, 13)} ${r.caseId} #${i} hand=${hand} judge=${flag}`);
        }
      }
    }
  } catch (err) {
    console.error(`Stopped: ${describeModelError(err)}`);
    process.exitCode = 1;
  }
  const t = tally(rows);
  console.log(`\nJudge ${version}${values.stored ? ' (stored verdicts)' : ''} on ${t.conversations} conversations from ${runs.length} run(s), ${t.judgeErrors} judge errors`);
  console.log(`  Caught ${t.caught} of ${t.problems} hand-found problems. Missed: ${t.missedCases.join(', ') || 'none'}`);
  console.log(`  False alarms ${t.falseAlarms} of ${t.fine} fine conversations: ${t.falseAlarmCases.join(', ') || 'none'}`);
  mkdirSync('reports/judge', { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const file = `reports/judge/${stamp}-${version}${values.stored ? '-stored' : ''}.json`;
  writeFileSync(file, JSON.stringify({ version, stored: values.stored, runs: runs.map((r) => r.run), case: caseFilter ?? null, repeat, tally: t, rows }, null, 2));
  console.log(`Saved: ${file}`);
}
