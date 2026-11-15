// Scoring for one eval conversation. Structured checks (outcome, tools,
// escalation) come first; text checks are normalized so different correct
// wordings still pass (PLAN.md 4.3). Every check returns a reason string, so a
// failure can be read without re-running anything.

import type { ToolCallRecord } from '../agent/loop.ts';
import type { EscalationReason } from '../agent/tools.ts';
import { normalizeOrderNumber } from '../store/store.ts';
import { findLeak } from '../agent/sanitize.ts';
import type { EvalCase, Fact, Outcome, ToolExpect } from './types.ts';

export type TurnRecord = {
  customer: string;
  reply: string;
  toolCalls: ToolCallRecord[];
  escalation?: { reason: EscalationReason; source: 'agent' | 'code' };
};

export type CaseScores = {
  /** Agent plus code safety nets: what a customer would experience. */
  resolution: boolean;
  /** Same checks, ignoring escalations raised by code safety nets. */
  resolutionAgentOnly: boolean;
  toolUse: boolean;
  expectedEscalation: boolean;
  escalated: boolean;
  escalatedByAgent: boolean;
  safetyNetFired: boolean;
  unnecessaryEscalation: boolean;
  missedEscalation: boolean;
  missedEscalationAgentOnly: boolean;
  unnecessaryEscalationAgentOnly: boolean;
  escalationReasonOk: boolean | null;
  outcome: string;
  failures: string[];
  toolFailures: string[];
};

/* ------------------------------------------------------------ normalizing */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ');
}

function dateVariants(iso: string): string[] {
  const [y, m, d] = iso.split('-').map(Number);
  const month = MONTHS[m - 1];
  const weekday = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return [iso, `${month} ${d}`, `${month.slice(0, 3)} ${d}`, `${month.slice(0, 3)}. ${d}`, `${d} ${month}`, `${d} ${month.slice(0, 3)}`, `${m}/${d}`, weekday];
}

export function factFound(text: string, fact: Fact): boolean {
  const t = normText(text);
  if ('any' in fact) return fact.any.some((p) => t.includes(normText(p)));
  if ('date' in fact) {
    return dateVariants(fact.date).some((v) => {
      const re = new RegExp(`(^|[^0-9a-z])${v.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![0-9])`);
      return re.test(t);
    });
  }
  const n = fact.money;
  const forms = Number.isInteger(n) ? [`${n}`, `${n}.00`] : [n.toFixed(2), `${n}`];
  return forms.some((f) => new RegExp(`(^|[^0-9.])\\$?\\s?${f.replace('.', '\\.')}(?![0-9])`).test(t));
}

export const describeFact = (f: Fact) => ('any' in f ? `one of [${f.any.slice(0, 4).join(' | ')}${f.any.length > 4 ? ' | …' : ''}]` : 'date' in f ? `date ${f.date}` : `amount $${f.money}`);

function normArg(v: unknown): string {
  return normalizeOrderNumber(String(v ?? '')).toUpperCase().trim();
}

export function callMatches(call: ToolCallRecord, exp: ToolExpect): boolean {
  const names = Array.isArray(exp.name) ? exp.name : [exp.name];
  if (!names.includes(call.name)) return false;
  for (const [k, v] of Object.entries(exp.args ?? {})) {
    const actual = (call.input as Record<string, unknown> | undefined)?.[k];
    if (normArg(actual) !== normArg(v)) return false;
  }
  return true;
}

const describeTool = (e: ToolExpect) => `${Array.isArray(e.name) ? e.name.join('|') : e.name}(${Object.entries(e.args ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')})`;

const okResult = (c: ToolCallRecord) => !c.isError && (c.output as any)?.ok === true;

/** A clarifying question, with or without a question mark ("Please tell me the order number."). */
const ASKS =
  /\?|\b(please (tell|share|send|provide|confirm|let me know|reply with)|let me know (which|what|the)|could you (tell|share|send|confirm)|can you (tell|share|send|confirm))\b|\b(i'll|i will|i) need (your|the) [^.]{0,40}\b(email|phone|order number|code)\b/i;

/* ------------------------------------------------------------- scoring */

export function scoreCase(c: EvalCase, turns: TurnRecord[]): CaseScores {
  const calls = turns.flatMap((t) => t.toolCalls);
  const replies = turns.map((t) => t.reply);
  const allReplies = replies.join('\n');
  const esc = turns.find((t) => t.escalation)?.escalation;
  const escalated = !!esc;
  const escalatedByAgent = esc?.source === 'agent';
  const returnStarted = calls.some((x) => x.name === 'startReturn' && okResult(x));
  const discountApplied = calls.some((x) => x.name === 'applyDiscountCode' && okResult(x));
  const lastReply = replies.at(-1) ?? '';
  const asksQuestion = (r: string) => ASKS.test(r);

  const outcome = escalated ? 'escalate' : returnStarted ? 'return_started' : discountApplied ? 'discount_applied' : asksQuestion(lastReply) ? 'clarify' : 'answer';
  const accepted: Outcome[] = Array.isArray(c.expect.outcome) ? c.expect.outcome : [c.expect.outcome];
  const expectedEscalation = accepted.includes('escalate');

  // An outcome check, given which escalations count.
  const outcomeOk = (countEscalation: boolean) => {
    const e = countEscalation;
    if (e) return accepted.includes('escalate');
    if (returnStarted) return accepted.includes('return_started');
    if (discountApplied) return accepted.includes('discount_applied');
    if (accepted.includes('clarify') && asksQuestion(lastReply)) return true;
    return accepted.includes('answer');
  };

  const failures: string[] = [];
  const textFailures: string[] = [];

  // Every case, every reply: internal text must never reach the customer (failure 05).
  turns.forEach((t, i) => {
    const leak = findLeak(t.reply);
    if (leak) textFailures.push(`turn ${i + 1}: reply leaks internal text (${leak})`);
  });
  for (const f of c.expect.mentions ?? []) {
    if (!factFound(allReplies, f)) textFailures.push(`reply never mentions ${describeFact(f)}`);
  }
  for (const f of c.expect.mustNotMention ?? []) {
    if (factFound(allReplies, f)) textFailures.push(`reply mentions forbidden ${describeFact(f)}`);
  }
  for (const tc of c.expect.turnChecks ?? []) {
    const t = turns[tc.turn];
    if (!t) {
      textFailures.push(`turn ${tc.turn + 1} never happened`);
      continue;
    }
    if (tc.asksQuestion && !asksQuestion(t.reply)) textFailures.push(`turn ${tc.turn + 1}: expected a clarifying question`);
    if (tc.noMutation && t.toolCalls.some((x) => (x.name === 'startReturn' || x.name === 'applyDiscountCode') && okResult(x))) {
      textFailures.push(`turn ${tc.turn + 1}: changed the order before the request was clear`);
    }
    for (const f of tc.mustNotMention ?? []) {
      if (factFound(t.reply, f)) textFailures.push(`turn ${tc.turn + 1}: mentions forbidden ${describeFact(f)}`);
    }
  }

  const systemOutcomeOk = outcomeOk(escalated);
  const agentOutcomeOk = outcomeOk(escalatedByAgent);
  if (!systemOutcomeOk) failures.push(`outcome was "${outcome}", expected ${accepted.map((o) => `"${o}"`).join(' or ')}`);
  failures.push(...textFailures);

  // Tool use: required calls in order, nothing forbidden, no malformed calls.
  const toolFailures: string[] = [];
  let from = 0;
  for (const exp of c.expect.toolsInOrder ?? []) {
    const idx = calls.findIndex((call, i) => i >= from && callMatches(call, exp));
    if (idx === -1) {
      toolFailures.push(`missing or out of order: ${describeTool(exp)}`);
    } else {
      from = idx + 1;
    }
  }
  for (const exp of c.expect.forbiddenTools ?? []) {
    const hit = calls.find((call) => callMatches(call, exp));
    if (hit) toolFailures.push(`forbidden call: ${hit.name}(${JSON.stringify(hit.input)})`);
  }
  for (const call of calls.filter((x) => x.isError)) toolFailures.push(`malformed call: ${call.name}(${JSON.stringify(call.input)})`);

  const reasons = c.expect.escalationReasons;
  const escalationReasonOk = escalated && expectedEscalation && reasons ? reasons.includes(esc!.reason) : null;

  return {
    resolution: systemOutcomeOk && textFailures.length === 0,
    resolutionAgentOnly: agentOutcomeOk && textFailures.length === 0,
    toolUse: toolFailures.length === 0,
    expectedEscalation,
    escalated,
    escalatedByAgent,
    safetyNetFired: esc?.source === 'code',
    unnecessaryEscalation: !expectedEscalation && escalated,
    missedEscalation: expectedEscalation && !escalated,
    unnecessaryEscalationAgentOnly: !expectedEscalation && escalatedByAgent,
    missedEscalationAgentOnly: expectedEscalation && !escalatedByAgent,
    escalationReasonOk,
    outcome,
    failures,
    toolFailures,
  };
}
