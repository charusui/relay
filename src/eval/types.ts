import type { Channel, EscalationReason } from '../agent/tools.ts';

export const CATEGORIES = ['Happy path', 'Angry customer', 'Ambiguous request', 'Prompt injection', 'Order does not exist', 'Policy edge'] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Something a reply must (or must not) contain. Matching is normalized so
 * correct answers in different words still pass:
 *  - date:  "2026-11-12" also matches "Nov 12", "November 12", "11/12", "Thursday"
 *  - money: 4.5 matches "$4.50", "4.50", "$4.5"
 *  - any:   any one of the phrases, case-insensitive
 */
export type Fact = { date: string } | { money: number } | { any: string[] };

/** A tool call to look for. `name` can list alternatives; `args` are matched loosely ('#1042' = '1042', case-insensitive). */
export type ToolExpect = { name: string | string[]; args?: Record<string, string> };

/**
 * Outcome the conversation must end in:
 *  answer            no hand-off and no store change (information, refusals, "not found")
 *  clarify           like answer, and the last reply asks the customer a question
 *  return_started    a return was opened, no hand-off
 *  discount_applied  a code was applied, no hand-off
 *  escalate          handed to a human
 */
export type Outcome = 'answer' | 'clarify' | 'return_started' | 'discount_applied' | 'escalate';

export type TurnCheck = {
  /** 0-based index of the customer turn whose reply is checked. */
  turn: number;
  asksQuestion?: boolean;
  noMutation?: boolean;
  mustNotMention?: Fact[];
};

export type EvalCase = {
  id: string;
  category: Category;
  /** dev: used while building and tuning. test: frozen; the only source of reported numbers. */
  split: 'dev' | 'test';
  title: string;
  channel: Channel;
  from: string;
  subject?: string;
  /** Customer messages, sent one after another. */
  turns: string[];
  expect: {
    /** One outcome, or several acceptable ones. */
    outcome: Outcome | Outcome[];
    /** When escalating, acceptable reasons (reported separately, not part of resolution). */
    escalationReasons?: EscalationReason[];
    /** Tool calls that must appear, in this order (other calls may come between). */
    toolsInOrder?: ToolExpect[];
    /** Tool calls that must never happen. */
    forbiddenTools?: ToolExpect[];
    /** Every fact must appear somewhere in the agent's replies. */
    mentions?: Fact[];
    /** None of these may appear in any reply. */
    mustNotMention?: Fact[];
    turnChecks?: TurnCheck[];
    /** Send to the AI judge for groundedness and tone (policy answers). */
    judge?: boolean;
  };
  /** Why the expectation is what it is, for whoever reads a failure. */
  rationale: string;
};
