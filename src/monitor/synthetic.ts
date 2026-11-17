// Synthetic check: a few scripted conversations sent through the real handler
// on a schedule (once a day on Vercel's free plan) and graded by the same
// grader as the eval suite. It answers "is the deployed agent still behaving?"
// with a pass/fail, not just "is the server up?".
//
// The cases come from the dev split, never the frozen test split, and run
// against a fresh mock store each time so nothing accumulates.

import type { ModelClient } from '../agent/model.ts';
import { QuotaExhaustedError } from '../agent/openaiCompat.ts';
import type { Variant } from '../agent/variants.ts';
import type { RelayDb } from '../db/db.ts';
import { handleInbound } from '../handler.ts';
import { cases } from '../eval/cases.ts';
import { scoreCase, type TurnRecord } from '../eval/score.ts';
import { MockStore } from '../store/store.ts';
import { raiseAlert, type Notify } from './alerts.ts';
import type { SyntheticCaseResult } from './metrics.ts';

/** Tracking, a return, a policy answer, an injection attempt, and a hand-off: one of each kind of job. */
export const SYNTHETIC_CASE_IDS = ['happy-02', 'happy-05', 'policy-10', 'inject-03', 'angry-03'];

export type SyntheticRun = { passed: number; total: number; errors: number; results: SyntheticCaseResult[]; stoppedForQuota: boolean };

export async function runSyntheticCheck(deps: { db: RelayDb; model: ModelClient; variant: Variant }, notify?: Notify, caseIds = SYNTHETIC_CASE_IDS): Promise<SyntheticRun> {
  const results: SyntheticCaseResult[] = [];
  let stoppedForQuota = false;
  for (const id of caseIds) {
    const c = cases.find((x) => x.id === id);
    if (!c) throw new Error(`Unknown synthetic case ${id}`);
    if (c.split !== 'dev') throw new Error(`Synthetic case ${id} must come from the dev split, not ${c.split}`);
    const store = new MockStore();
    const turns: TurnRecord[] = [];
    let conversationId: string | undefined;
    try {
      for (const text of c.turns) {
        const r = await handleInbound({ db: deps.db, store, model: deps.model, variant: deps.variant }, { channel: c.channel, from: c.from, text, subject: c.subject, conversationId, traffic: 'synthetic' });
        conversationId = r.conversationId;
        turns.push({ customer: text, reply: r.reply, toolCalls: r.toolCalls, escalation: r.escalation ? { reason: r.escalation.reason, source: r.escalation.source } : undefined });
        if (r.status === 'escalated') break;
      }
      const s = scoreCase(c, turns);
      const pass = s.resolution && s.toolUse;
      results.push({ caseId: c.id, title: c.title, pass, reasons: [...s.failures, ...s.toolFailures.map((t) => `tools: ${t}`)], conversationId });
    } catch (err) {
      const message = (err as Error).message;
      await deps.db.recordFailure({ conversationId, traffic: 'synthetic', source: 'synthetic', message });
      results.push({ caseId: c.id, title: c.title, pass: false, reasons: [], conversationId, error: message.slice(0, 300) });
      if (err instanceof QuotaExhaustedError) {
        stoppedForQuota = true;
        break;
      }
    } finally {
      // Synthetic threads never stay open: a later check or a real customer must not continue them.
      if (conversationId) await deps.db.closeConversation(conversationId);
    }
  }
  const passed = results.filter((r) => r.pass).length;
  const errors = results.filter((r) => r.error).length;
  const run: SyntheticRun = { passed, total: caseIds.length, errors, results, stoppedForQuota };
  await deps.db.recordSyntheticRun({ passed, total: run.total, errors, details: results });

  if (passed < run.total) {
    const bad = results.filter((r) => !r.pass).map((r) => `${r.caseId}${r.error ? ' (error)' : ''}`);
    await raiseAlert(
      deps.db,
      { rule: 'synthetic_check', message: `Synthetic check: ${passed}/${run.total} passed${stoppedForQuota ? ', stopped: model quota used up' : ''}. Failing: ${bad.join(', ')}.`, value: passed, threshold: run.total },
      notify,
    );
  }
  return run;
}
