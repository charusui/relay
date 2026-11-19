// Turns a run's results into numbers and a Markdown report a person can read.
// Every number shows its count ("34/43"), not just a percentage, so nobody
// mistakes a 3-case sample for a result.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { PRICES_CHECKED } from '../agent/pricing.ts';
import { REFUND_APPROVAL_THRESHOLD } from '../config.ts';
import { cases as ALL_CASES } from './cases.ts';
import { REPORTS_DIR, type CaseResult, type RunMeta } from './runner.ts';
import { CATEGORIES } from './types.ts';

export type Ratio = { k: number; n: number; pct: number | null };
const ratio = (k: number, n: number): Ratio => ({ k, n, pct: n ? Math.round((1000 * k) / n) / 10 : null });
export const fmtRatio = (r: Ratio) => (r.n ? `${r.pct}% (${r.k}/${r.n})` : 'n/a');

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

export type Summary = {
  scored: number;
  errored: number;
  resolution: Ratio;
  resolutionAgentOnly: Ratio;
  toolUse: Ratio;
  unnecessaryEscalation: Ratio;
  unnecessaryEscalationAgentOnly: Ratio;
  missedEscalation: Ratio;
  missedEscalationAgentOnly: Ratio;
  safetyNetFired: number;
  escalationReasonWrong: number;
  groundedness: Ratio;
  /** Judge versions present. More than one means groundedness mixes judges and is not reported. */
  judgeVersions: string[];
  judged: number;
  judgeErrors: number;
  toneOk: Ratio;
  tokensPerConversation: number | null;
  paidEquivalentPerConversation: number | null;
  latencyP50s: number | null;
  latencyP95s: number | null;
  rateLimitWaitS: number;
  /** Replies whose internal reasoning was stripped before sending, and replies withheld for leaking internals. */
  repliesSanitized: number;
  repliesWithheld: number;
  byCategory: Record<string, { resolution: Ratio; toolUse: Ratio }>;
};

export function summarize(results: CaseResult[]): Summary {
  const ok = results.filter((r) => r.scores);
  const s = ok.map((r) => r.scores!);
  const notExpected = s.filter((x) => !x.expectedEscalation);
  const expected = s.filter((x) => x.expectedEscalation);
  const judged = ok.filter((r) => r.judge && !r.judge.error);
  const withClaims = judged.filter((r) => r.judge!.grounded !== null);
  // A judge is its rubric version AND its model: verdicts from different judges are never mixed.
  const judgeVersions = [...new Set(judged.map((r) => `${r.judge!.version ?? 'v1'}@${r.judge!.judgeModel}`))].sort();
  const turnLat = ok.flatMap((r) => r.turns.map((t) => t.metrics.activeLatencyMs / 1000));
  const paid = ok.map((r) => r.paidEquivalentUsd);
  const byCategory: Summary['byCategory'] = {};
  for (const cat of CATEGORIES) {
    const rs = ok.filter((r) => r.category === cat);
    if (rs.length) byCategory[cat] = { resolution: ratio(rs.filter((r) => r.scores!.resolution).length, rs.length), toolUse: ratio(rs.filter((r) => r.scores!.toolUse).length, rs.length) };
  }
  return {
    scored: ok.length,
    errored: results.length - ok.length,
    resolution: ratio(s.filter((x) => x.resolution).length, s.length),
    resolutionAgentOnly: ratio(s.filter((x) => x.resolutionAgentOnly).length, s.length),
    toolUse: ratio(s.filter((x) => x.toolUse).length, s.length),
    unnecessaryEscalation: ratio(notExpected.filter((x) => x.unnecessaryEscalation).length, notExpected.length),
    unnecessaryEscalationAgentOnly: ratio(notExpected.filter((x) => x.unnecessaryEscalationAgentOnly).length, notExpected.length),
    missedEscalation: ratio(expected.filter((x) => x.missedEscalation).length, expected.length),
    missedEscalationAgentOnly: ratio(expected.filter((x) => x.missedEscalationAgentOnly).length, expected.length),
    safetyNetFired: s.filter((x) => x.safetyNetFired).length,
    escalationReasonWrong: s.filter((x) => x.escalationReasonOk === false).length,
    groundedness: judgeVersions.length > 1 ? ratio(0, 0) : ratio(withClaims.filter((r) => r.judge!.grounded).length, withClaims.length),
    judgeVersions,
    judged: judged.length,
    judgeErrors: ok.filter((r) => r.judge?.error).length,
    toneOk: ratio(judged.filter((r) => r.judge!.toneOk).length, judged.length),
    tokensPerConversation: ok.length ? Math.round(ok.reduce((a, r) => a + r.totalTokens, 0) / ok.length) : null,
    paidEquivalentPerConversation: ok.length && paid.every((p) => p !== null) ? Math.round((1e6 * paid.reduce((a, p) => a! + p!, 0)!) / ok.length) / 1e6 : null,
    latencyP50s: percentile(turnLat, 50),
    latencyP95s: percentile(turnLat, 95),
    repliesSanitized: ok.reduce((a, r) => a + r.turns.filter((t) => t.metrics.sanitized).length, 0),
    repliesWithheld: ok.reduce((a, r) => a + r.turns.filter((t) => t.metrics.leak).length, 0),
    rateLimitWaitS: Math.round(ok.reduce((a, r) => a + r.turns.reduce((b, t) => b + t.metrics.waitMs, 0), 0) / 1000),
    byCategory,
  };
}

const sec = (x: number | null) => (x === null ? 'n/a' : `${x.toFixed(2)} s`);

export function transcriptMd(r: CaseResult): string {
  const lines: string[] = [];
  r.turns.forEach((t, i) => {
    lines.push(`- **Customer (${i + 1}):** ${t.customer}`);
    for (const c of t.toolCalls) lines.push(`  - tool \`${c.name}(${JSON.stringify(c.input)})\` → \`${JSON.stringify(c.output).slice(0, 240)}\``);
    if (t.escalation) lines.push(`  - escalated: ${t.escalation.reason} (by ${t.escalation.source})`);
    lines.push(`- **Relay:** ${t.reply.replace(/\n+/g, ' ⏎ ')}`);
  });
  return lines.join('\n');
}

export function renderReport(meta: RunMeta, results: CaseResult[]): string {
  const s = summarize(results);
  const out: string[] = [];
  out.push(`# Eval report: ${meta.runId}`);
  if (meta.offline) out.push('\n> **SIMULATED.** This run used the offline scripted stand-in, not a real model. These numbers test the pipeline only. Never put them on the portfolio.');
  if (!meta.complete) out.push(`\n> **INCOMPLETE.** ${results.length}/${meta.caseIds.length} conversations ran. ${meta.stoppedReason ?? ''} Resume with \`npm run eval -- --resume ${meta.runId}\`.`);
  if (meta.caseIds.length < 20) out.push(`\n> **Small sample (${meta.caseIds.length} cases).** Fine for a pilot or debugging; too small to report.`);

  out.push('\n| | |\n|---|---|');
  out.push(`| Variant | \`${meta.variant}\` |`);
  out.push(`| Model | ${meta.offline ? 'offline stub' : `${meta.provider}: \`${meta.model}\``} |`);
  out.push(`| Split | ${meta.split} (case set \`${meta.caseSetHash}\`) |`);
  out.push(`| Judge | ${meta.judge ? `${meta.judge} (${meta.judgeScope === 'all' ? 'every conversation' : 'policy cases only'})` : 'off'} |`);
  out.push(`| Retrieval | ${meta.retrievalVersion ?? 'bm25-stem-v1'} |`);
  out.push(`| Started | ${meta.startedAt} |`);
  out.push(`| Data | Mock store "Pinecrest Supply" (fictional), store clock 2026-11-10, refund approval over $${REFUND_APPROVAL_THRESHOLD} |`);

  out.push('\n## Headline');
  out.push('Eval results on scripted conversations against a fictional store, not production traffic.\n');
  out.push('| Metric | Result | What it means |\n|---|---|---|');
  out.push(`| Resolution accuracy | **${fmtRatio(s.resolution)}** | Conversation ended in the expected outcome with the required facts |`);
  out.push(`| Correct tool use | **${fmtRatio(s.toolUse)}** | Required tools with the right arguments, in order; nothing forbidden |`);
  out.push(`| Unnecessary escalations | **${fmtRatio(s.unnecessaryEscalation)}** | Handed off when it should have resolved (of cases that should not escalate) |`);
  out.push(`| Missed escalations | **${fmtRatio(s.missedEscalation)}** | Did not hand off when it should have (of cases that should escalate) |`);
  out.push(`| Groundedness | **${fmtRatio(s.groundedness)}** | ${s.judgeVersions.length > 1 ? `**Not reported: verdicts mix judge versions ${s.judgeVersions.join(' and ')}. Re-judge the run.** ` : ''}Judge ${s.judgeVersions.join('') || ''}: every policy and order claim in the replies is supported by a tool result or policy (${s.judged} judged, ${s.judgeErrors} judge errors) |`);
  out.push(`| Latency p50 / p95 | **${sec(s.latencyP50s)} / ${sec(s.latencyP95s)}** | Per customer message, rate-limit waiting excluded (${s.rateLimitWaitS} s of waiting removed). Free tier: not representative of paid latency |`);
  out.push(`| Tokens per conversation | **${s.tokensPerConversation ?? 'n/a'}** | Input + output, all model calls |`);
  out.push(
    `| Cost per conversation | **$0 actual**; ${s.paidEquivalentPerConversation === null ? 'paid-equivalent not available (no list price for this model in data/prices.json)' : `**$${s.paidEquivalentPerConversation.toFixed(5)}** at paid list price (prices checked ${PRICES_CHECKED})`} | Free tier |`,
  );

  out.push('\n## Agent alone vs agent plus safety nets');
  out.push('Code safety nets escalate when a customer asks for a person, says they have complained before, or a refund is over the threshold. "Agent alone" ignores those escalations, to show what the model did by itself.\n');
  out.push('| | Agent + safety nets | Agent alone |\n|---|---|---|');
  out.push(`| Resolution accuracy | ${fmtRatio(s.resolution)} | ${fmtRatio(s.resolutionAgentOnly)} |`);
  out.push(`| Unnecessary escalations | ${fmtRatio(s.unnecessaryEscalation)} | ${fmtRatio(s.unnecessaryEscalationAgentOnly)} |`);
  out.push(`| Missed escalations | ${fmtRatio(s.missedEscalation)} | ${fmtRatio(s.missedEscalationAgentOnly)} |`);
  out.push(`\nSafety net fired in ${s.safetyNetFired} conversation(s). Escalations with an unexpected reason: ${s.escalationReasonWrong}.`);
  out.push(`Output guard: internal reasoning stripped from ${s.repliesSanitized} reply(s); ${s.repliesWithheld} reply(s) withheld for leaking internals (customer handed off instead).`);

  out.push('\n## By category\n');
  out.push('| Category | Resolution | Tool use |\n|---|---|---|');
  for (const [cat, v] of Object.entries(s.byCategory)) out.push(`| ${cat} | ${fmtRatio(v.resolution)} | ${fmtRatio(v.toolUse)} |`);

  const failed = results.filter((r) => r.error || !r.scores!.resolution || !r.scores!.toolUse || r.judge?.grounded === false);
  out.push(`\n## Failures to investigate (${failed.length})`);
  out.push('Read each one before trusting the numbers above: some failures may be grader mistakes, not agent mistakes (PLAN.md 4.3).');
  for (const r of failed) {
    const c = ALL_CASES.find((x) => x.id === r.caseId);
    out.push(`\n### ${r.caseId}: ${r.title}${r.repeat > 1 ? ` (repeat ${r.repeat})` : ''}`);
    out.push(`*${r.category}.* Expected: ${JSON.stringify(c?.expect.outcome)}. ${c?.rationale ?? ''}\n`);
    if (r.error) out.push(`- **Error:** ${r.error}`);
    for (const f of r.scores?.failures ?? []) out.push(`- Resolution: ${f}`);
    for (const f of r.scores?.toolFailures ?? []) out.push(`- Tool use: ${f}`);
    if (r.judge?.grounded === false) out.push(`- Judge: unsupported claims: ${r.judge.unsupportedClaims.join(' | ')}`);
    out.push(`\nConversation \`${r.conversationId ?? 'n/a'}\`:\n`);
    out.push(transcriptMd(r));
  }

  out.push('\n## Grader check (fill in by hand)');
  out.push('- [ ] Read every failure above and marked any that are grader mistakes');
  out.push('- [ ] Read at least 5 passing conversations to confirm they really pass');
  out.push('- [ ] Grader mistakes fixed in code or in a case (log it in PLAN.md change log), and the run repeated');
  out.push('\nOnly a complete, non-simulated run on the **test** split, with this check done, may be reported as a result (PLAN.md: never invent metrics).');
  return out.join('\n');
}

export function writeReport(meta: RunMeta, results: CaseResult[]): { md: string; json: string } {
  const base = path.join(REPORTS_DIR, meta.runId);
  const md = `${base}.md`;
  const json = `${base}.json`;
  writeFileSync(md, renderReport(meta, results));
  writeFileSync(json, JSON.stringify({ meta, summary: summarize(results) }, null, 2));
  return { md, json };
}
