// Eval runner: sends every scripted conversation through the real
// handleInbound() (same code path as customers), scores it, optionally judges
// it, and appends the result to reports/runs/<runId>/results.jsonl as it goes.
// Runs are resumable: a free-tier daily quota can end a run part-way, and
// `--resume <runId>` continues where it stopped (PLAN.md 4.12).

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelClient } from '../agent/model.ts';
import { QuotaExhaustedError } from '../agent/openaiCompat.ts';
import { addUsage, paidEquivalentUsd, totalTokens, zeroUsage, type TokenUsage } from '../agent/pricing.ts';
import { buildSystemPrompt, getVariant } from '../agent/variants.ts';
import { RETRIEVAL_VERSION } from '../policy/retrieval.ts';
import { RelayDb } from '../db/db.ts';
import { handleInbound } from '../handler.ts';
import { MockStore } from '../store/store.ts';
import { cases as ALL_CASES } from './cases.ts';
import { judgeConversation, type JudgeVerdict } from './judge.ts';
import { scoreCase, type CaseScores, type TurnRecord } from './score.ts';
import type { EvalCase } from './types.ts';

export const REPORTS_DIR = 'reports';

export type RunMeta = {
  runId: string;
  label?: string;
  variant: string;
  provider: string;
  model: string;
  offline: boolean;
  split: 'dev' | 'test' | 'all';
  /** Hash of the case definitions in the split: runs are only comparable when it matches. */
  caseSetHash: string;
  caseIds: string[];
  judge: string | null;
  /** all: judge every conversation (catches made-up order facts too). marked: only cases with judge: true. */
  judgeScope?: 'all' | 'marked';
  /** Missing on runs made before versioning, which used 'bm25-stem-v1'. */
  retrievalVersion?: string;
  startedAt: string;
  finishedAt?: string;
  complete: boolean;
  stoppedReason?: string;
};

export type TurnMetrics = { activeLatencyMs: number; latencyMs: number; waitMs: number; usage: TokenUsage; steps: number; sanitized?: boolean; leak?: string };

export type CaseResult = {
  caseId: string;
  category: string;
  title: string;
  repeat: number;
  conversationId?: string;
  turns: (TurnRecord & { metrics: TurnMetrics })[];
  scores?: CaseScores;
  judge?: JudgeVerdict;
  usage: TokenUsage;
  totalTokens: number;
  paidEquivalentUsd: number | null;
  error?: string;
};

export function selectCases(split: RunMeta['split']): EvalCase[] {
  return split === 'all' ? ALL_CASES : ALL_CASES.filter((c) => c.split === split);
}

export function caseSetHash(cs: EvalCase[]): string {
  return createHash('sha256').update(JSON.stringify(cs)).digest('hex').slice(0, 12);
}

export function runDir(runId: string) {
  return path.join(REPORTS_DIR, 'runs', runId);
}

export function loadRun(runId: string): { meta: RunMeta; results: CaseResult[] } {
  const dir = runDir(runId);
  if (!existsSync(path.join(dir, 'meta.json'))) throw new Error(`No run "${runId}" in ${path.join(REPORTS_DIR, 'runs')}.`);
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RunMeta;
  const file = path.join(dir, 'results.jsonl');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  // Later lines win (a resumed run may retry an errored case).
  const byKey = new Map<string, CaseResult>();
  for (const l of lines) {
    const r = JSON.parse(l) as CaseResult;
    byKey.set(`${r.caseId}#${r.repeat}`, r);
  }
  return { meta, results: [...byKey.values()] };
}

export type RunOptions = {
  variant: string;
  model: ModelClient;
  judge: ModelClient | null;
  judgeScope?: 'all' | 'marked';
  split: RunMeta['split'];
  limit?: number;
  category?: string;
  caseIds?: string[];
  repeat?: number;
  label?: string;
  resume?: string;
  log?: (s: string) => void;
};

export async function runEval(opts: RunOptions): Promise<{ meta: RunMeta; results: CaseResult[] }> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const variant = getVariant(opts.variant);
  const splitCases = selectCases(opts.split);
  const hash = caseSetHash(splitCases);

  let meta: RunMeta;
  let done = new Set<string>();
  if (opts.resume) {
    const prev = loadRun(opts.resume);
    meta = prev.meta;
    if (meta.caseSetHash !== hash) {
      throw new Error(`Cannot resume ${opts.resume}: the ${meta.split} case set changed since it started (${meta.caseSetHash} -> ${hash}). Start a new run.`);
    }
    if (meta.variant !== variant.id || meta.model !== `${opts.model.modelId}` || meta.provider !== opts.model.provider) {
      throw new Error(`Cannot resume ${opts.resume}: it used ${meta.variant} on ${meta.provider}:${meta.model}. Resume with the same --variant/--provider/--model.`);
    }
    done = new Set(prev.results.filter((r) => !r.error).map((r) => `${r.caseId}#${r.repeat}`));
    meta.complete = false;
    delete meta.stoppedReason;
  } else {
    let selected = splitCases;
    if (opts.category) selected = selected.filter((c) => c.category.toLowerCase() === opts.category!.toLowerCase());
    if (opts.caseIds?.length) selected = selected.filter((c) => opts.caseIds!.includes(c.id));
    if (opts.limit) selected = selected.slice(0, opts.limit);
    if (!selected.length) throw new Error('No cases match the filters.');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
    meta = {
      runId: `${stamp}-${variant.id}-${opts.model.provider}-${opts.split}-${randomUUID().slice(0, 4)}`,
      label: opts.label,
      variant: variant.id,
      provider: opts.model.provider,
      model: opts.model.modelId,
      offline: opts.model.offline,
      split: opts.split,
      caseSetHash: hash,
      caseIds: selected.map((c) => c.id),
      judge: opts.judge ? `${opts.judge.provider}:${opts.judge.modelId}` : null,
      judgeScope: opts.judge ? (opts.judgeScope ?? 'all') : undefined,
      retrievalVersion: RETRIEVAL_VERSION,
      startedAt: new Date().toISOString(),
      complete: false,
    };
  }

  const dir = runDir(meta.runId);
  mkdirSync(dir, { recursive: true });
  const saveMeta = () => writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  saveMeta();

  const db = await RelayDb.open();
  await db.createEvalRun({ id: meta.runId, label: meta.label, variant: meta.variant, provider: meta.provider, model: meta.model, split: meta.split, caseSetHash: meta.caseSetHash, offline: meta.offline });

  const repeat = opts.repeat ?? 1;
  const todo: { c: EvalCase; rep: number }[] = [];
  for (let rep = 1; rep <= repeat; rep++) {
    for (const id of meta.caseIds) {
      if (done.has(`${id}#${rep}`)) continue;
      todo.push({ c: splitCases.find((x) => x.id === id)!, rep });
    }
  }
  log(`Run ${meta.runId}: ${todo.length} conversation(s) to go (${variant.id} on ${opts.model.offline ? 'OFFLINE stub' : `${meta.provider}:${meta.model}`}, split ${meta.split}).`);

  let n = 0;
  try {
    for (const { c, rep } of todo) {
      n++;
      const result = await runCase(c, rep, meta, opts, db, variant);
      appendFileSync(path.join(dir, 'results.jsonl'), `${JSON.stringify(result)}\n`);
      if (result.scores) {
        await db.recordEvalResult({ runId: meta.runId, caseId: c.id, repeat: rep, category: c.category, conversationId: result.conversationId, scores: result.scores });
      }
      const s = result.scores;
      const mark = result.error ? 'ERROR' : s!.resolution ? 'pass ' : 'FAIL ';
      const detail = result.error ? result.error.slice(0, 300) : [...s!.failures, ...s!.toolFailures.map((t) => `tools: ${t}`)].join('; ');
      log(`  [${n}/${todo.length}] ${mark} ${c.id}  ${detail}`);
    }
    const errored = loadRun(meta.runId).results.filter((r) => r.error).length;
    meta.complete = errored === 0;
    if (errored) meta.stoppedReason = `${errored} conversation(s) errored. Fix the cause, then resume to retry only those.`;
  } catch (err) {
    if (err instanceof QuotaExhaustedError) {
      meta.stoppedReason = err.message;
      log(`\nStopped: ${err.message}\nResume later with: npm run eval -- --resume ${meta.runId}`);
    } else {
      meta.stoppedReason = (err as Error).message;
      throw err;
    }
  } finally {
    meta.finishedAt = new Date().toISOString();
    saveMeta();
    await db.close();
  }
  return loadRun(meta.runId);
}

async function runCase(c: EvalCase, rep: number, meta: RunMeta, opts: RunOptions, db: RelayDb, variant: ReturnType<typeof getVariant>): Promise<CaseResult> {
  const store = new MockStore(); // fresh, untouched store for every conversation
  const deps = { db, store, model: opts.model, variant };
  const turns: CaseResult['turns'] = [];
  let conversationId: string | undefined;
  let usage = zeroUsage();
  try {
    for (const text of c.turns) {
      const r = await handleInbound(deps, {
        channel: c.channel,
        from: c.from,
        text,
        subject: c.subject,
        conversationId,
        evalRunId: meta.runId,
        evalCaseId: c.id,
      });
      conversationId = r.conversationId;
      usage = addUsage(usage, r.usage);
      turns.push({
        customer: text,
        reply: r.reply,
        toolCalls: r.toolCalls,
        escalation: r.escalation ? { reason: r.escalation.reason, source: r.escalation.source } : undefined,
        metrics: { activeLatencyMs: r.activeLatencyMs, latencyMs: r.latencyMs, waitMs: r.waitMs, usage: r.usage, steps: r.steps, sanitized: r.sanitized, leak: r.leak },
      });
      if (r.status === 'escalated') break; // the script stops once a human has the conversation
    }
  } catch (err) {
    if (err instanceof QuotaExhaustedError) throw err;
    return { caseId: c.id, category: c.category, title: c.title, repeat: rep, conversationId, turns, usage, totalTokens: totalTokens(usage), paidEquivalentUsd: null, error: (err as Error).message };
  }

  const scores = scoreCase(c, turns);
  const scope = meta.judgeScope ?? 'marked';
  const judge = opts.judge && (scope === 'all' || c.expect.judge) ? await judgeConversation(opts.judge, turns, { agentInstructions: buildSystemPrompt(variant) }) : undefined;
  return {
    caseId: c.id,
    category: c.category,
    title: c.title,
    repeat: rep,
    conversationId,
    turns,
    scores,
    judge,
    usage,
    totalTokens: totalTokens(usage),
    paidEquivalentUsd: opts.model.offline ? null : paidEquivalentUsd(opts.model.modelId, usage),
  };
}
