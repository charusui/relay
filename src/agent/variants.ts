// A variant is what changes between A/B runs on the same provider and model:
// the system prompt and how policies reach the model. Provider and model are
// chosen per run (--provider / --model) and recorded in every report.
//
// Rule (PLAN.md 4.2): a new variant starts from a real failure in an eval
// report, changes one thing, and gets a change-log entry with its result.

import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { loadPassages } from '../policy/retrieval.ts';
import { fromRoot } from '../paths.ts';
import { toolDefinitions } from './tools.ts';

export type Variant = {
  id: string;
  description: string;
  prompt: string; // file in src/agent/prompts, without .md
  /** 'tool': policies come from the searchPolicy tool. 'in_prompt': all policies are pasted into the system prompt. */
  policyMode: 'tool' | 'in_prompt';
};

/** The variant that chat, evals and A/B use unless told otherwise. Changed only by an A/B decision (see PLAN.md). */
export const DEFAULT_VARIANT = 'no-gap-filling-v3'; // 2026-11-15, A/B 03 (docs/results/ab-03-no-gap-filling.md); before: state-tool-outcome (A/B 02), policy-before-handoff (A/B 01)

export const variants: Record<string, Variant> = {
  baseline: {
    id: 'baseline',
    description: 'Rules-style prompt; policies retrieved with the searchPolicy tool',
    prompt: 'baseline',
    policyMode: 'tool',
  },
  // From failure 01 (ambig-01, baseline v1): the low_confidence rule told the model to hand off whenever
  // no tool could do the job, even when a policy gives the customer a self-serve step. One change: that rule.
  'policy-before-handoff': {
    id: 'policy-before-handoff',
    description: 'Baseline, with the low_confidence rule changed: check policies for a self-serve step before handing off',
    prompt: 'policy-before-handoff',
    policyMode: 'tool',
  },
  // From A/B 01's side effect (happy-06: refund amount left out) and the Shopify live check (label promised
  // 'shortly'): after acting, the agent paraphrases tool results loosely. One change: restate them exactly.
  'state-tool-outcome': {
    id: 'state-tool-outcome',
    description: 'policy-before-handoff plus one line: after acting, state the amount and next steps exactly as the tool gives them',
    prompt: 'state-tool-outcome',
    policyMode: 'tool',
  },
  // From A/B 02 hand check (failure 06): happy-10 said a package "is not considered lost" with no policy saying so, and
  // inject-02 tried the staff code planted in an order note (failure 02). Two lines, both about not acting or speaking
  // beyond what the customer and the tools actually gave. Developed on new dev cases happy-13 and inject-11.
  "no-gap-filling": {
    id: "no-gap-filling",
    description: "state-tool-outcome plus two lines: apply only codes the customer typed; no reassurance (lost/late) beyond tools and policy",
    prompt: "no-gap-filling",
    policyMode: "tool",
  },
  // no-gap-filling's first test run (stopped by quota at 17/43) left the delivery estimate out of happy-10; the
  // likely cause is "and nothing more" in the lost/late line. One change: ask for the estimate, drop "nothing more".
  // Found on the test split, so it is checked on new dev case happy-14 before the test split is run again.
  "no-gap-filling-v2": {
    id: "no-gap-filling-v2",
    description: "no-gap-filling with the lost/late line reworded: include the estimated delivery date; no \"and nothing more\"",
    prompt: "no-gap-filling-v2",
    policyMode: "tool",
  },
  // v2's dev pilot (20261115T1327-no-gap-filling-v2-gemini-dev-ed01): happy-13 said "not considered lost yet" in 1 of 3 runs.
  // One change: say plainly not to comment on lost-or-not at all, with the phrasings the model used.
  "no-gap-filling-v3": {
    id: "no-gap-filling-v3",
    description: "no-gap-filling-v2 with the lost/late line made explicit: no lost-or-not statement at all",
    prompt: "no-gap-filling-v3",
    policyMode: "tool",
  },
  // Planned experiment (PLAN.md 4.9): is retrieval worth it at this size?
  // Compare accuracy and tokens against baseline. Not a guessed fix.
  'policies-in-prompt': {
    id: 'policies-in-prompt',
    description: 'Same prompt, but every policy passage pasted into the system prompt and no searchPolicy tool',
    prompt: 'baseline',
    policyMode: 'in_prompt',
  },
};


export function getVariant(id: string): Variant {
  const v = variants[id];
  if (!v) throw new Error(`Unknown variant "${id}". Known: ${Object.keys(variants).join(', ')}`);
  return v;
}

const POLICY_RULE_TOOL =
  '- Use searchPolicy before answering any policy question, and answer only from the passages it returns. If no passage covers the question, do not answer from general knowledge.';
const POLICY_RULE_IN_PROMPT =
  '- Answer policy questions only from the store policies at the end of this prompt. If they do not cover the question, do not answer from general knowledge.';

export function buildSystemPrompt(v: Variant): string {
  const raw = readFileSync(fromRoot('src', 'agent', 'prompts', `${v.prompt}.md`), 'utf8').trim();
  if (v.policyMode === 'tool') return raw.replace('{{POLICY_RULE}}', POLICY_RULE_TOOL);
  const policies = loadPassages()
    .map((p) => `## ${p.doc}: ${p.section}\n${p.text}`)
    .join('\n\n');
  return `${raw.replace('{{POLICY_RULE}}', POLICY_RULE_IN_PROMPT)}\n\n# Store policies\n\n${policies}`;
}

export function toolsFor(v: Variant): Anthropic.Tool[] {
  return v.policyMode === 'tool' ? toolDefinitions : toolDefinitions.filter((t) => t.name !== 'searchPolicy');
}
