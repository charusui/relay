// A/B comparison on the same eval set.
//
//   Compare two finished runs:
//     npm run ab -- --a <runIdA> --b <runIdB>
//   Run two prompt variants on the same provider/model, then compare:
//     npm run ab -- --variants baseline,policies-in-prompt [--split test] [--provider gemini]
//   Pilot: same variant on two providers (pick the free model by data, PLAN.md 4.10):
//     npm run ab -- --providers gemini,groq --split dev --limit 10
//
// Reports paired flips (cases B fixed vs cases B broke), because with ~40
// cases a few points of difference can be luck (PLAN.md 4.7).

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv } from '../config.ts';
import { describeModelError } from '../agent/model.ts';
import { createJudgeModel, createModel } from '../agent/providers.ts';
import { DEFAULT_VARIANT } from '../agent/variants.ts';
import { fmtRatio, summarize, writeReport, type Ratio, type Summary } from './report.ts';
import { loadRun, REPORTS_DIR, runEval, type CaseResult, type RunMeta } from './runner.ts';

type Run = { meta: RunMeta; results: CaseResult[] };

/** Per case: did it pass (majority of repeats)? */
function passMap(results: CaseResult[], key: 'resolution' | 'toolUse'): Map<string, boolean> {
  const byCase = new Map<string, boolean[]>();
  for (const r of results) {
    if (!r.scores) continue;
    byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r.scores[key]]);
  }
  return new Map([...byCase].map(([id, xs]) => [id, xs.filter(Boolean).length * 2 >= xs.length]));
}

const pp = (a: Ratio, b: Ratio) => (a.pct === null || b.pct === null ? 'n/a' : `${b.pct - a.pct >= 0 ? '+' : ''}${(b.pct - a.pct).toFixed(1)} pts`);
const num = (a: number | null, b: number | null, unit = '') =>
  a === null || b === null ? 'n/a' : `${b - a >= 0 ? '+' : ''}${(b - a).toFixed(unit === 's' ? 2 : 0)}${unit}${a ? ` (${b - a >= 0 ? '+' : ''}${Math.round(((b - a) / a) * 100)}%)` : ''}`;

export function compareRuns(A: Run, B: Run, force = false): string {
  const problems: string[] = [];
  if (A.meta.caseSetHash !== B.meta.caseSetHash || A.meta.split !== B.meta.split) {
    const msg = `The runs used different case sets (${A.meta.split}/${A.meta.caseSetHash} vs ${B.meta.split}/${B.meta.caseSetHash}).`;
    if (!force) throw new Error(`${msg} They are not comparable. Re-run both on the same split, or pass --force.`);
    problems.push(msg);
  }
  // Compare only cases both runs scored.
  const idsA = new Set(A.results.filter((r) => r.scores).map((r) => r.caseId));
  const idsB = new Set(B.results.filter((r) => r.scores).map((r) => r.caseId));
  const common = [...idsA].filter((id) => idsB.has(id));
  const a = A.results.filter((r) => common.includes(r.caseId));
  const b = B.results.filter((r) => common.includes(r.caseId));
  if (!common.length) throw new Error('The two runs have no successfully scored cases in common, so there is nothing to compare. Check each run report for errors.');
  const erroredA = A.results.filter((r) => r.error).length;
  const erroredB = B.results.filter((r) => r.error).length;
  if (erroredA || erroredB) problems.push(`Errored conversations: A ${erroredA}, B ${erroredB}. They are left out of the comparison.`);
  if (common.length < Math.max(idsA.size, idsB.size)) problems.push(`Only the ${common.length} cases both runs completed are compared.`);
  if (A.meta.offline || B.meta.offline) problems.push('At least one run is SIMULATED (offline stub). Not a real comparison.');
  if (!A.meta.complete || !B.meta.complete) problems.push('At least one run is incomplete.');

  const rvA = A.meta.retrievalVersion ?? 'bm25-stem-v1';
  const rvB = B.meta.retrievalVersion ?? 'bm25-stem-v1';
  if (rvA !== rvB) problems.push(`The runs used different policy retrieval (${rvA} vs ${rvB}), so retrieval is a second difference besides the one being tested.`);
  const jvA = summarize(a).judgeVersions;
  const jvB = summarize(b).judgeVersions;
  if (jvA.length > 1 || jvB.length > 1 || (jvA.length && jvB.length && jvA[0] !== jvB[0])) {
    problems.push(`Groundedness is not comparable: judge versions A [${jvA.join(', ')}], B [${jvB.join(', ')}]. Re-judge both runs with the same judge.`);
  }
  const sameModel = A.meta.provider === B.meta.provider && A.meta.model === B.meta.model;
  const sameVariant = A.meta.variant === B.meta.variant;
  const kind = sameModel && !sameVariant ? 'Prompt/flow variants, same model' : !sameModel && sameVariant ? 'Models, same prompt' : sameModel && sameVariant ? 'Same variant and model (repeatability check)' : 'Variant AND model both differ: the result cannot say which change caused it';
  if (!sameModel && !sameVariant) problems.push(kind);

  const sa = summarize(a);
  const sb = summarize(b);
  const resA = passMap(a, 'resolution');
  const resB = passMap(b, 'resolution');
  const fixed = common.filter((id) => !resA.get(id) && resB.get(id));
  const broke = common.filter((id) => resA.get(id) && !resB.get(id));
  const net = fixed.length - broke.length;

  const worse: string[] = [];
  const lower = (x: Ratio, y: Ratio) => x.k / (x.n || 1) > y.k / (y.n || 1);
  if (lower(sa.toolUse, sb.toolUse)) worse.push('correct tool use');
  if (lower(sb.unnecessaryEscalation, sa.unnecessaryEscalation)) worse.push('unnecessary escalations');
  if (lower(sb.missedEscalation, sa.missedEscalation)) worse.push('missed escalations');
  if (sa.groundedness.n && sb.groundedness.n && lower(sa.groundedness, sb.groundedness)) worse.push('groundedness');

  const NOISE = 2;
  let verdict: string;
  if (Math.abs(net) <= NOISE) verdict = `**No clear difference.** B fixed ${fixed.length} and broke ${broke.length} (net ${net >= 0 ? '+' : ''}${net}), within run-to-run noise (±${NOISE} cases). Don't ship on this alone; repeat the runs (\`--repeat\`) or look at the per-case flips.`;
  else if (net > 0 && worse.length === 0) verdict = `**B wins.** Net ${net} more conversations resolved (fixed ${fixed.length}, broke ${broke.length}) without making another metric worse. Ship B, and log it in PLAN.md.`;
  else if (net > 0) verdict = `**B resolves more (net +${net}) but is worse on ${worse.join(', ')}.** Don't ship until that trade-off is understood.`;
  else verdict = `**Keep A.** B resolved ${-net} fewer (fixed ${fixed.length}, broke ${broke.length}).`;

  const row = (label: string, x: Ratio, y: Ratio) => `| ${label} | ${fmtRatio(x)} | ${fmtRatio(y)} | ${pp(x, y)} |`;
  const out: string[] = [];
  out.push(`# A/B: ${A.meta.variant} vs ${B.meta.variant}`);
  out.push(`\nComparing: ${kind}. ${common.length} cases, split \`${A.meta.split}\`.`);
  for (const p of problems) out.push(`\n> **Caution:** ${p}`);
  out.push('\n| | A · baseline | B · candidate |\n|---|---|---|');
  out.push(`| Run | \`${A.meta.runId}\` | \`${B.meta.runId}\` |`);
  out.push(`| Variant | ${A.meta.variant} | ${B.meta.variant} |`);
  out.push(`| Model | ${A.meta.offline ? 'offline stub' : `${A.meta.provider}: ${A.meta.model}`} | ${B.meta.offline ? 'offline stub' : `${B.meta.provider}: ${B.meta.model}`} |`);
  out.push('\n## Metrics\n');
  out.push('| Metric | A · baseline | B · candidate | Change |\n|---|---|---|---|');
  out.push(row('Resolution accuracy', sa.resolution, sb.resolution));
  out.push(row('Resolution, agent alone', sa.resolutionAgentOnly, sb.resolutionAgentOnly));
  out.push(row('Correct tool use', sa.toolUse, sb.toolUse));
  out.push(row('Unnecessary escalations', sa.unnecessaryEscalation, sb.unnecessaryEscalation));
  out.push(row('Missed escalations', sa.missedEscalation, sb.missedEscalation));
  out.push(row('Groundedness', sa.groundedness, sb.groundedness));
  out.push(`| Tokens per conversation | ${sa.tokensPerConversation ?? 'n/a'} | ${sb.tokensPerConversation ?? 'n/a'} | ${num(sa.tokensPerConversation, sb.tokensPerConversation)} |`);
  out.push(`| Paid-equivalent cost / conversation | ${sa.paidEquivalentPerConversation === null ? 'n/a' : `$${sa.paidEquivalentPerConversation.toFixed(5)}`} | ${sb.paidEquivalentPerConversation === null ? 'n/a' : `$${sb.paidEquivalentPerConversation.toFixed(5)}`} | |`);
  out.push(`| Latency p95 (waits excluded) | ${sa.latencyP95s?.toFixed(2) ?? 'n/a'} s | ${sb.latencyP95s?.toFixed(2) ?? 'n/a'} s | ${num(sa.latencyP95s, sb.latencyP95s, 's')} |`);
  out.push('\n## Decision\n');
  out.push('Rule: B ships only if it beats A on the same eval set without making another metric worse.\n');
  out.push(verdict);
  out.push('\n## Paired flips (resolution)\n');
  out.push(`- **Fixed by B (${fixed.length}):** ${fixed.join(', ') || 'none'}`);
  out.push(`- **Broken by B (${broke.length}):** ${broke.join(', ') || 'none'}`);
  out.push(`\n## By category\n`);
  out.push('| Category | A | B |\n|---|---|---|');
  for (const cat of Object.keys({ ...sa.byCategory, ...sb.byCategory })) {
    out.push(`| ${cat} | ${sa.byCategory[cat] ? fmtRatio(sa.byCategory[cat].resolution) : 'n/a'} | ${sb.byCategory[cat] ? fmtRatio(sb.byCategory[cat].resolution) : 'n/a'} |`);
  }
  out.push(`\nFull reports: \`reports/${A.meta.runId}.md\`, \`reports/${B.meta.runId}.md\`.`);
  return out.join('\n');
}

export type { Summary };

/* ------------------------------------------------------------------ CLI */

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('src/eval/ab.ts');
if (isMain) {
  loadEnv();
  const { values } = parseArgs({
    options: {
      a: { type: 'string' },
      b: { type: 'string' },
      variants: { type: 'string' },
      providers: { type: 'string' },
      variant: { type: 'string', default: DEFAULT_VARIANT },
      provider: { type: 'string' },
      model: { type: 'string' },
      split: { type: 'string', default: 'test' },
      limit: { type: 'string' },
      offline: { type: 'boolean', default: false },
      'no-judge': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });
  try {
    let A: Run;
    let B: Run;
    if (values.a && values.b) {
      A = loadRun(values.a);
      B = loadRun(values.b);
    } else {
      const split = values.split as 'dev' | 'test' | 'all';
      const limit = values.limit ? Number(values.limit) : undefined;
      const judge = values.offline || values['no-judge'] ? null : createJudgeModel();
      const arms: { variant: string; provider?: string }[] = values.variants
        ? values.variants.split(',').map((v) => ({ variant: v.trim(), provider: values.provider }))
        : values.providers
          ? values.providers.split(',').map((p) => ({ variant: values.variant!, provider: p.trim() }))
          : [];
      if (arms.length !== 2) throw new Error('Pass --a <run> --b <run>, or --variants a,b, or --providers p1,p2.');
      const runs: Run[] = [];
      for (const arm of arms) {
        const model = createModel({ provider: arm.provider, model: values.providers ? undefined : values.model, offline: values.offline });
        const r = await runEval({ variant: arm.variant, model, judge, split, limit, label: 'ab' });
        writeReport(r.meta, r.results);
        if (!r.meta.complete) throw new Error(`Run ${r.meta.runId} stopped early (${r.meta.stoppedReason}). Resume it with npm run eval -- --resume ${r.meta.runId}, then compare with --a/--b.`);
        runs.push(r);
      }
      [A, B] = runs;
    }
    const md = compareRuns(A, B, values.force);
    const file = path.join(REPORTS_DIR, `ab-${A.meta.runId}-vs-${B.meta.runId}.md`);
    writeFileSync(file, md);
    console.log(`\n${md.split('## Decision')[1]?.split('## Paired')[0]?.trim() ?? ''}\n\nA/B report: ${file}`);
  } catch (err) {
    console.error(`\nA/B failed: ${describeModelError(err)}`);
    process.exitCode = 1;
  }
}
