// Alert rules over the last 24 hours of non-eval traffic. Each rule fires at
// most once per cooldown, is stored in the alerts table, and is posted to Slack
// when SLACK_WEBHOOK_URL is set.
//
// The thresholds are starting points chosen before any live traffic existed,
// not tuned values. They are written down here so they can be tuned openly.

import type { RelayDb } from '../db/db.ts';
import { summary, type Summary } from './metrics.ts';

export type AlertRule = {
  id: string;
  describe: string;
  /** Returns a message when the rule is breached, else null. */
  check: (now: Summary, baseline: Summary) => { message: string; value: number; threshold: number } | null;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

export const RULES: AlertRule[] = [
  {
    id: 'error_rate',
    describe: 'More than 20% of messages in 24 h got the fallback reply (at least 3 messages)',
    check: (s) => {
      const attempts = s.turns + s.failures;
      if (attempts < 3 || s.errorRate === null || s.errorRate <= 0.2) return null;
      return { message: `${pct(s.errorRate)} of messages failed in the last 24 h (${s.failures} of ${attempts}). Customers got the fallback reply.`, value: s.errorRate, threshold: 0.2 };
    },
  },
  {
    id: 'handoff_rate',
    describe: 'More than 50% of conversations in 24 h were handed to a person (at least 4 conversations)',
    check: (s) => {
      if (s.conversations < 4 || s.handoffRate === null || s.handoffRate <= 0.5) return null;
      return { message: `${pct(s.handoffRate)} of conversations were handed to a person in the last 24 h (${s.handoffs} of ${s.conversations}). On the eval set 7 of 43 should be.`, value: s.handoffRate, threshold: 0.5 };
    },
  },
  {
    id: 'latency_p95',
    describe: 'p95 reply time over 20 s in 24 h, rate-limit waits excluded (at least 5 replies)',
    check: (s) => {
      if (s.turns < 5 || s.latencyP95Ms === null || s.latencyP95Ms <= 20_000) return null;
      return { message: `p95 reply time was ${(s.latencyP95Ms / 1000).toFixed(1)} s in the last 24 h (rate-limit waits excluded).`, value: s.latencyP95Ms, threshold: 20_000 };
    },
  },
  {
    id: 'token_spike',
    describe: 'Average tokens per reply in 24 h more than 1.5x the previous 7 days (at least 5 replies in each)',
    check: (s, base) => {
      if (s.turns < 5 || base.turns < 5 || !s.avgTokensPerTurn || !base.avgTokensPerTurn) return null;
      const ratio = s.avgTokensPerTurn / base.avgTokensPerTurn;
      if (ratio <= 1.5) return null;
      return { message: `Tokens per reply jumped to ${Math.round(s.avgTokensPerTurn)} (${ratio.toFixed(1)}x the 7-day average of ${Math.round(base.avgTokensPerTurn)}).`, value: ratio, threshold: 1.5 };
    },
  },
  {
    id: 'withheld_reply',
    describe: 'Any reply withheld by the output guard for leaking internals in 24 h',
    check: (s) => (s.withheldReplies > 0 ? { message: `${s.withheldReplies} reply(s) leaked internal reasoning or tool names and were withheld; the customers were handed to a person.`, value: s.withheldReplies, threshold: 0 } : null),
  },
];

export const COOLDOWN_HOURS = 6;

export type Notify = (text: string) => Promise<void>;

export type FiredAlert = { rule: string; message: string; posted: boolean };

/** Record an alert (and post it) unless the same rule fired within the cooldown. */
export async function raiseAlert(db: RelayDb, a: { rule: string; message: string; value: number | null; threshold: number | null }, notify?: Notify, now = new Date()): Promise<FiredAlert | null> {
  const last = await db.lastAlertAt(a.rule);
  if (last && now.getTime() - last.getTime() < COOLDOWN_HOURS * 3_600_000) return null;
  let posted = false;
  if (notify) {
    try {
      await notify(`:rotating_light: Relay monitoring: ${a.message}`);
      posted = true;
    } catch {
      posted = false; // the alert is still recorded and shown on the dashboard
    }
  }
  await db.recordAlert({ ...a, posted });
  return { rule: a.rule, message: a.message, posted };
}

export async function evaluateAlerts(db: RelayDb, notify?: Notify): Promise<FiredAlert[]> {
  const now = await summary(db, { hours: 24 });
  const week = await summary(db, { hours: 24 * 8 });
  // Baseline = the 7 days before the last 24 h.
  const baseTurns = week.turns - now.turns;
  const baseTokens = week.totalTokens - now.totalTokens;
  const baseline: Summary = { ...week, turns: baseTurns, avgTokensPerTurn: baseTurns > 0 ? baseTokens / baseTurns : null };
  const fired: FiredAlert[] = [];
  for (const rule of RULES) {
    const hit = rule.check(now, baseline);
    if (!hit) continue;
    const f = await raiseAlert(db, { rule: rule.id, ...hit }, notify);
    if (f) fired.push(f);
  }
  return fired;
}
