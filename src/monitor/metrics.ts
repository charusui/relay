// Monitoring queries for the dashboard and the alert rules. They read the
// same tables the handler writes, and leave eval conversations out (those are
// measured by the eval suite, not by monitoring).
//
// Every count is cast in SQL (::int, ::float8) so node-postgres and PGlite
// return plain numbers.

import type { RelayDb, Traffic } from '../db/db.ts';

export const ALL_TRAFFIC: Traffic[] = ['live', 'synthetic', 'demo'];

export type WindowOpts = { hours: number; traffic?: Traffic[] };

export type Summary = {
  windowHours: number;
  traffic: Traffic[];
  conversations: number;
  customerMessages: number;
  /** Agent replies that were logged (one per customer message the agent answered). */
  turns: number;
  /** Messages Relay could not answer: the customer got the fallback reply. */
  failures: number;
  /** failures / (turns + failures); null with no traffic. */
  errorRate: number | null;
  /** Conversations handed to a person. */
  handoffs: number;
  handoffRate: number | null;
  handoffsBySource: { agent: number; code: number };
  handoffReasons: { reason: string; n: number }[];
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  avgTokensPerTurn: number | null;
  avgTokensPerConversation: number | null;
  totalTokens: number;
  /** Replies withheld by the output guard for leaking internals (failure 05). */
  withheldReplies: number;
  toolCalls: { name: string; n: number; errors: number }[];
};

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const nOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// Shared filter: non-eval conversations of the chosen traffic kinds.
const CONV = `c.eval_run_id is null and c.traffic = any($2::text[])`;

export async function summary(db: RelayDb, opts: WindowOpts): Promise<Summary> {
  const traffic = opts.traffic ?? ALL_TRAFFIC;
  const p = [opts.hours, traffic];
  const since = `now() - make_interval(hours => $1::int)`;

  const [conv, msgs, turns, fails, esc, reasons, tools] = await Promise.all([
    db.sql.query<{ n: number }>(`select count(*)::int as n from conversations c where c.created_at >= ${since} and ${CONV}`, p),
    db.sql.query<{ n: number }>(
      `select count(*)::int as n from messages m join conversations c on c.id = m.conversation_id where m.role = 'customer' and m.created_at >= ${since} and ${CONV}`,
      p,
    ),
    db.sql.query<{ n: number; p50: number | null; p95: number | null; avg_tokens: number | null; total_tokens: number; withheld: number }>(
      `select count(*)::int as n,
              percentile_cont(0.5) within group (order by t.active_latency_ms)::float8 as p50,
              percentile_cont(0.95) within group (order by t.active_latency_ms)::float8 as p95,
              avg(t.input_tokens + t.output_tokens)::float8 as avg_tokens,
              coalesce(sum(t.input_tokens + t.output_tokens), 0)::float8 as total_tokens,
              count(*) filter (where t.abnormal = 'leaked_internals')::int as withheld
         from turns t join conversations c on c.id = t.conversation_id
        where t.created_at >= ${since} and ${CONV}`,
      p,
    ),
    db.sql.query<{ n: number }>(`select count(*)::int as n from failures f where f.created_at >= now() - make_interval(hours => $1::int) and f.traffic = any($2::text[])`, p),
    db.sql.query<{ convs: number; agent: number; code: number }>(
      `select count(distinct e.conversation_id)::int as convs,
              count(*) filter (where e.source = 'agent')::int as agent,
              count(*) filter (where e.source = 'code')::int as code
         from escalations e join conversations c on c.id = e.conversation_id
        where e.created_at >= ${since} and ${CONV}`,
      p,
    ),
    db.sql.query<{ reason: string; n: number }>(
      `select e.reason, count(*)::int as n from escalations e join conversations c on c.id = e.conversation_id
        where e.created_at >= ${since} and ${CONV} group by e.reason order by n desc, e.reason`,
      p,
    ),
    db.sql.query<{ name: string; n: number; errors: number }>(
      `select tc.name, count(*)::int as n, count(*) filter (where tc.is_error)::int as errors
         from tool_calls tc join conversations c on c.id = tc.conversation_id
        where tc.created_at >= ${since} and ${CONV} group by tc.name order by n desc, tc.name`,
      p,
    ),
  ]);

  const conversations = n(conv.rows[0]?.n);
  const t = turns.rows[0];
  const turnCount = n(t?.n);
  const failures = n(fails.rows[0]?.n);
  const attempts = turnCount + failures;
  const handoffs = n(esc.rows[0]?.convs);
  return {
    windowHours: opts.hours,
    traffic,
    conversations,
    customerMessages: n(msgs.rows[0]?.n),
    turns: turnCount,
    failures,
    errorRate: attempts ? failures / attempts : null,
    handoffs,
    handoffRate: conversations ? Math.min(1, handoffs / conversations) : null,
    handoffsBySource: { agent: n(esc.rows[0]?.agent), code: n(esc.rows[0]?.code) },
    handoffReasons: reasons.rows.map((r) => ({ reason: r.reason, n: n(r.n) })),
    latencyP50Ms: nOrNull(t?.p50),
    latencyP95Ms: nOrNull(t?.p95),
    avgTokensPerTurn: nOrNull(t?.avg_tokens),
    avgTokensPerConversation: conversations ? n(t?.total_tokens) / conversations : null,
    totalTokens: n(t?.total_tokens),
    withheldReplies: n(t?.withheld),
    toolCalls: tools.rows.map((r) => ({ name: r.name, n: n(r.n), errors: n(r.errors) })),
  };
}

export type DayPoint = { day: string; conversations: number; handoffs: number; failures: number; turns: number; p95Ms: number | null; avgTokensPerTurn: number | null };

/** One point per UTC day for the last `days` days, including days with no traffic. */
export async function daily(db: RelayDb, days: number, traffic: Traffic[] = ALL_TRAFFIC): Promise<DayPoint[]> {
  const r = await db.sql.query<{ day: string; conversations: number; handoffs: number; failures: number; turns: number; p95: number | null; avg_tokens: number | null }>(
    `with days as (
       select generate_series((now() at time zone 'utc')::date - ($1::int - 1), (now() at time zone 'utc')::date, interval '1 day')::date as day
     )
     select to_char(d.day, 'YYYY-MM-DD') as day,
       (select count(*)::int from conversations c where (c.created_at at time zone 'utc')::date = d.day and ${CONV}) as conversations,
       (select count(distinct e.conversation_id)::int from escalations e join conversations c on c.id = e.conversation_id
         where (e.created_at at time zone 'utc')::date = d.day and ${CONV}) as handoffs,
       (select count(*)::int from failures f where (f.created_at at time zone 'utc')::date = d.day and f.traffic = any($2::text[])) as failures,
       (select count(*)::int from turns t join conversations c on c.id = t.conversation_id where (t.created_at at time zone 'utc')::date = d.day and ${CONV}) as turns,
       (select percentile_cont(0.95) within group (order by t.active_latency_ms)::float8 from turns t join conversations c on c.id = t.conversation_id
         where (t.created_at at time zone 'utc')::date = d.day and ${CONV}) as p95,
       (select avg(t.input_tokens + t.output_tokens)::float8 from turns t join conversations c on c.id = t.conversation_id
         where (t.created_at at time zone 'utc')::date = d.day and ${CONV}) as avg_tokens
     from days d order by d.day`,
    [days, traffic],
  );
  return r.rows.map((x) => ({
    day: x.day,
    conversations: n(x.conversations),
    handoffs: n(x.handoffs),
    failures: n(x.failures),
    turns: n(x.turns),
    p95Ms: nOrNull(x.p95),
    avgTokensPerTurn: nOrNull(x.avg_tokens),
  }));
}

export type ConversationListItem = {
  id: string;
  traffic: Traffic;
  channel: string;
  contact: string;
  status: string;
  createdAt: string;
  firstMessage: string | null;
  turns: number;
  tokens: number;
  handoffReason: string | null;
};

/** Hide most of a phone number or email address on the dashboard. */
export function maskContact(contact: string): string {
  const at = contact.indexOf('@');
  if (at > 0) return `${contact[0]}•••${contact.slice(at)}`;
  const digits = contact.replace(/\D/g, '');
  if (digits.length >= 6) return `${contact.startsWith('+') ? '+' : ''}${digits.slice(0, 1)}•••${digits.slice(-4)}`;
  return '•••';
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export async function recentConversations(db: RelayDb, limit = 25, traffic: Traffic[] = ALL_TRAFFIC): Promise<ConversationListItem[]> {
  const r = await db.sql.query<{ id: string; traffic: Traffic; channel: string; contact: string; status: string; created_at: Date | string; first_message: string | null; turns: number; tokens: number; handoff_reason: string | null }>(
    `select c.id, c.traffic, c.channel, c.contact, c.status, c.created_at,
       (select m.body from messages m where m.conversation_id = c.id and m.role = 'customer' order by m.id limit 1) as first_message,
       (select count(*)::int from turns t where t.conversation_id = c.id) as turns,
       (select coalesce(sum(t.input_tokens + t.output_tokens), 0)::int from turns t where t.conversation_id = c.id) as tokens,
       (select e.reason from escalations e where e.conversation_id = c.id order by e.created_at limit 1) as handoff_reason
     from conversations c where c.eval_run_id is null and c.traffic = any($2::text[])
     order by c.created_at desc limit $1`,
    [limit, traffic],
  );
  return r.rows.map((x) => ({
    id: x.id,
    traffic: x.traffic,
    channel: x.channel,
    contact: maskContact(x.contact),
    status: x.status,
    createdAt: iso(x.created_at),
    firstMessage: x.first_message,
    turns: n(x.turns),
    tokens: n(x.tokens),
    handoffReason: x.handoff_reason,
  }));
}

export type ConversationDetail = {
  id: string;
  traffic: Traffic;
  channel: string;
  contact: string;
  status: string;
  variant: string;
  model: string;
  createdAt: string;
  messages: { role: string; body: string; at: string }[];
  turns: { at: string; activeLatencyMs: number; tokens: number; steps: number; abnormal: string | null; tools: { name: string; input: unknown; output: unknown; isError: boolean }[] }[];
  escalations: { reason: string; source: string; summary: string; at: string }[];
};

export async function conversationDetail(db: RelayDb, id: string): Promise<ConversationDetail | null> {
  const c = await db.sql.query<{ id: string; traffic: Traffic; channel: string; contact: string; status: string; variant: string; model: string; created_at: Date | string; eval_run_id: string | null }>(
    `select id, traffic, channel, contact, status, variant, model, created_at, eval_run_id from conversations where id = $1`,
    [id],
  );
  const row = c.rows[0];
  if (!row || row.eval_run_id) return null;
  const [msgs, turns, tools, esc] = await Promise.all([
    db.sql.query<{ role: string; body: string; created_at: Date | string }>(`select role, body, created_at from messages where conversation_id = $1 order by id`, [id]),
    db.sql.query<{ id: number; created_at: Date | string; active_latency_ms: number; tokens: number; steps: number; abnormal: string | null }>(
      `select id, created_at, active_latency_ms::float8 as active_latency_ms, (input_tokens + output_tokens)::int as tokens, steps, abnormal from turns where conversation_id = $1 order by id`,
      [id],
    ),
    db.sql.query<{ turn_id: number; name: string; input: unknown; output: unknown; is_error: boolean }>(
      `select turn_id, name, input, output, is_error from tool_calls where conversation_id = $1 order by turn_id, seq`,
      [id],
    ),
    db.sql.query<{ reason: string; source: string; summary: string; created_at: Date | string }>(
      `select reason, source, summary, created_at from escalations where conversation_id = $1 order by created_at`,
      [id],
    ),
  ]);
  return {
    id: row.id,
    traffic: row.traffic,
    channel: row.channel,
    contact: maskContact(row.contact),
    status: row.status,
    variant: row.variant,
    model: row.model,
    createdAt: iso(row.created_at),
    messages: msgs.rows.map((m) => ({ role: m.role, body: m.body, at: iso(m.created_at) })),
    turns: turns.rows.map((t) => ({
      at: iso(t.created_at),
      activeLatencyMs: n(t.active_latency_ms),
      tokens: n(t.tokens),
      steps: n(t.steps),
      abnormal: t.abnormal,
      tools: tools.rows.filter((x) => n(x.turn_id) === n(t.id)).map((x) => ({ name: x.name, input: x.input, output: x.output, isError: x.is_error })),
    })),
    escalations: esc.rows.map((e) => ({ reason: e.reason, source: e.source, summary: e.summary, at: iso(e.created_at) })),
  };
}

export type AlertRow = { rule: string; message: string; value: number | null; threshold: number | null; posted: boolean; at: string };

export async function recentAlerts(db: RelayDb, limit = 20): Promise<AlertRow[]> {
  const r = await db.sql.query<{ rule: string; message: string; value: number | null; threshold: number | null; posted: boolean; created_at: Date | string }>(
    `select rule, message, value, threshold, posted, created_at from alerts order by created_at desc limit $1`,
    [limit],
  );
  return r.rows.map((a) => ({ rule: a.rule, message: a.message, value: nOrNull(a.value), threshold: nOrNull(a.threshold), posted: a.posted, at: iso(a.created_at) }));
}

/** The most recent synthetic checks, newest first. */
export async function recentSyntheticRuns(db: RelayDb, limit = 14) {
  const r = await db.sql.query<{ id: number; passed: number; total: number; errors: number; details: unknown; created_at: Date | string }>(
    `select id, passed, total, errors, details, created_at from synthetic_runs order by created_at desc limit $1`,
    [limit],
  );
  return r.rows.map((x) => ({ id: n(x.id), passed: n(x.passed), total: n(x.total), errors: n(x.errors), details: x.details as SyntheticCaseResult[], at: iso(x.created_at) }));
}

export type SyntheticCaseResult = { caseId: string; title: string; pass: boolean; reasons: string[]; conversationId?: string; error?: string };
