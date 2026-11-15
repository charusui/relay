// AI judge for the two things code cannot check well: groundedness (is every
// policy or order claim supported by the policies or tool results?) and tone.
// Runs only on cases marked `judge: true`, using a different provider from
// the agent where possible (PLAN.md 4.4).

import type { ModelClient } from '../agent/model.ts';
import { QuotaExhaustedError } from '../agent/openaiCompat.ts';
import { loadPassages } from '../policy/retrieval.ts';
import { STORE_NOW } from '../../data/seed.ts';
import type { TurnRecord } from './score.ts';

/** Bump when the rubric or the judge's inputs change. Verdicts from different versions are never compared. */
export const JUDGE_VERSION = 'v2-context'; // v1 = no agent context (store date); verdicts without a version are v1

export type JudgeVerdict = {
  version?: string;
  grounded: boolean | null; // null = no factual claims to check
  unsupportedClaims: string[];
  toneOk: boolean;
  notes: string;
  judgeModel: string;
  error?: string;
};

const RUBRIC = `You grade one customer-support conversation for an online store. Be strict and literal.

1. grounded: List every factual claim the AGENT makes about store policy (windows, fees, timings, rules, contact details) or about the customer's order (status, dates, amounts, tracking). A claim is supported only if it appears in STORE POLICIES, in the TOOL RESULTS, or in AGENT CONTEXT (what the agent was told before the conversation, such as today's date). Paraphrase is fine; new facts are not. Generic courtesy ("happy to help") is not a claim.
   - true: at least one claim, all supported
   - false: at least one unsupported claim
   - null: no factual claims at all
2. tone_ok: true if the agent is polite, calm and clear, and does not blame, lecture or argue with the customer.

Reply with ONLY a JSON object, no other text:
{"grounded": true|false|null, "unsupported_claims": ["..."], "tone_ok": true|false, "notes": "one short sentence"}`;

export async function judgeConversation(judge: ModelClient, turns: TurnRecord[]): Promise<JudgeVerdict> {
  const policies = loadPassages().map((p) => `[${p.doc} / ${p.section}] ${p.text}`).join('\n');
  const transcript = turns
    .map((t, i) => {
      const tools = t.toolCalls.map((c) => `  TOOL ${c.name}(${JSON.stringify(c.input)}) -> ${JSON.stringify(c.output)}`).join('\n');
      return `--- turn ${i + 1}\nCUSTOMER: ${t.customer}\n${tools ? `TOOL RESULTS:\n${tools}\n` : ''}AGENT: ${t.reply}`;
    })
    .join('\n');
  const judgeModel = `${judge.provider}:${judge.modelId}`;
  try {
    const res = await judge.create({
      system: RUBRIC,
      context: '',
      tools: [],
      messages: [{ role: 'user', content: `AGENT CONTEXT:\nToday's date (store time): ${STORE_NOW.slice(0, 10)}.\n\nSTORE POLICIES:\n${policies}\n\nCONVERSATION:\n${transcript}` }],
    });
    const text = res.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('\n');
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error(`judge returned no JSON: ${text.slice(0, 200)}`);
    const v = JSON.parse(json);
    return {
      grounded: v.grounded === null ? null : Boolean(v.grounded),
      unsupportedClaims: Array.isArray(v.unsupported_claims) ? v.unsupported_claims.map(String) : [],
      toneOk: Boolean(v.tone_ok),
      notes: String(v.notes ?? ''),
      judgeModel,
      version: JUDGE_VERSION,
    };
  } catch (err) {
    if (err instanceof QuotaExhaustedError) throw err; // stop the run; it can resume later
    return { grounded: null, unsupportedClaims: [], toneOk: true, notes: '', judgeModel, version: JUDGE_VERSION, error: (err as Error).message };
  }
}
