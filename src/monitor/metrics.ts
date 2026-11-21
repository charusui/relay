// Monitoring queries for the dashboard and the alert rules. They read the
// same tables the handler writes, and leave eval conversations out (those are
// measured by the eval suite, not by monitoring).
//
// Every count is cast in SQL (::int, ::float8) so node-postgres and PGlite
// return plain numbers.

import { cleanHandoffSummary } from '../agent/handoff-summary.ts';
import type { RelayDb, Traffic } from '../db/db.ts';

export const ALL_TRAFFIC: Traffic[] = ['live', 'synthetic', 'demo'];

/** hours: window length. offsetHours: how far back the window ends (0 = now), for previous-period comparisons. */
export type WindowOpts = { hours: number; traffic?: Traffic[]; offsetHours?: number };

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
  const p = [opts.hours, traffic, opts.offsetHours ?? 0];
  // Window: from (offset + hours) ago up to offset ago.
  const inWindow = (col: string) => `${col} >= now() - make_interval(hours => ($1::int + $3::int)) and ${col} < now() - make_interval(hours => $3::int)`;

  const [conv, msgs, turns, fails, esc, reasons, tools] = await Promise.all([
    db.sql.query<{ n: number }>(`select count(*)::int as n from conversations c where ${inWindow('c.created_at')} and ${CONV}`, p),
    db.sql.query<{ n: number }>(
      `select count(*)::int as n from messages m join conversations c on c.id = m.conversation_id where m.role = 'customer' and ${inWindow('m.created_at')} and ${CONV}`,
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
        where ${inWindow('t.created_at')} and ${CONV}`,
      p,
    ),
    db.sql.query<{ n: number }>(`select count(*)::int as n from failures f where ${inWindow('f.created_at')} and f.traffic = any($2::text[])`, p),
    db.sql.query<{ convs: number; agent: number; code: number }>(
      `select count(distinct e.conversation_id)::int as convs,
              count(*) filter (where e.source = 'agent')::int as agent,
              count(*) filter (where e.source = 'code')::int as code
         from escalations e join conversations c on c.id = e.conversation_id
        where ${inWindow('e.created_at')} and ${CONV}`,
      p,
    ),
    db.sql.query<{ reason: string; n: number }>(
      `select e.reason, count(*)::int as n from escalations e join conversations c on c.id = e.conversation_id
        where ${inWindow('e.created_at')} and ${CONV} group by e.reason order by n desc, e.reason`,
      p,
    ),
    db.sql.query<{ name: string; n: number; errors: number }>(
      `select tc.name, count(*)::int as n, count(*) filter (where tc.is_error)::int as errors
         from tool_calls tc join conversations c on c.id = tc.conversation_id
        where ${inWindow('tc.created_at')} and ${CONV} group by tc.name order by n desc, tc.name`,
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
  turns: { at: string; activeLatencyMs: number; tokens: number; steps: number; abnormal: string | null; tools: { name: string; input: unknown; output: unknown; isError: boolean; durationMs: number }[] }[];
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
    db.sql.query<{ turn_id: number; name: string; input: unknown; output: unknown; is_error: boolean; duration_ms: number }>(
      `select turn_id, name, input, output, is_error, duration_ms::float8 as duration_ms from tool_calls where conversation_id = $1 order by turn_id, seq`,
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
      tools: tools.rows.filter((x) => n(x.turn_id) === n(t.id)).map((x) => ({ name: x.name, input: x.input, output: x.output, isError: x.is_error, durationMs: n(x.duration_ms) })),
    })),
    escalations: esc.rows.map((e) => ({ reason: e.reason, source: e.source, summary: cleanHandoffSummary(e.summary), at: iso(e.created_at) })),
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


/* ------------------------------------------------------------ conversation list */

export type Outcome = 'answered' | 'handed_off' | 'failed';
export type ConversationSort = 'started' | 'replies' | 'tokens' | 'latency';

export type ListOpts = {
  hours: number;
  traffic?: Traffic[];
  /** Text search over the customer's and the agent's messages (case-insensitive). */
  q?: string;
  outcome?: Outcome;
  channel?: 'sms' | 'email';
  sort?: ConversationSort;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

export type ConversationRowView = ConversationListItem & { outcome: Outcome; avgLatencyMs: number | null; lastMessage: string | null };

// A conversation "failed" when a customer message got no agent reply (the model call threw;
// the customer got the channel's fallback text, which is not logged as an agent message).
const OUTCOME_SQL = `case
    when exists (select 1 from escalations e where e.conversation_id = c.id) then 'handed_off'
    when (select count(*) from messages m where m.conversation_id = c.id and m.role = 'customer')
       > (select count(*) from messages m where m.conversation_id = c.id and m.role = 'agent') then 'failed'
    else 'answered' end`;

const SORT_SQL: Record<ConversationSort, string> = {
  started: 'c.created_at',
  replies: 'turns',
  tokens: 'tokens',
  latency: 'avg_latency_ms',
};

export async function listConversations(db: RelayDb, opts: ListOpts): Promise<{ rows: ConversationRowView[]; total: number }> {
  const params: unknown[] = [opts.hours, opts.traffic ?? ALL_TRAFFIC];
  const where = [`c.eval_run_id is null`, `c.traffic = any($2::text[])`, `c.created_at >= now() - make_interval(hours => $1::int)`];
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim().replace(/[\\%_]/g, (m) => '\\' + m)}%`);
    where.push(`(c.id ilike $${params.length} or exists (select 1 from messages m where m.conversation_id = c.id and m.body ilike $${params.length}))`);
  }
  if (opts.channel) {
    params.push(opts.channel);
    where.push(`c.channel = $${params.length}`);
  }
  const base = `
    select c.id, c.traffic, c.channel, c.contact, c.status, c.created_at,
      (select m.body from messages m where m.conversation_id = c.id and m.role = 'customer' order by m.id limit 1) as first_message,
      (select m.body from messages m where m.conversation_id = c.id order by m.id desc limit 1) as last_message,
      (select count(*)::int from turns t where t.conversation_id = c.id) as turns,
      (select coalesce(sum(t.input_tokens + t.output_tokens), 0)::int from turns t where t.conversation_id = c.id) as tokens,
      (select avg(t.active_latency_ms)::float8 from turns t where t.conversation_id = c.id) as avg_latency_ms,
      (select e.reason from escalations e where e.conversation_id = c.id order by e.created_at limit 1) as handoff_reason,
      ${OUTCOME_SQL} as outcome
    from conversations c where ${where.join(' and ')}`;
  const outcomeFilter = opts.outcome ? (params.push(opts.outcome), `where x.outcome = $${params.length}`) : '';
  const sortCol = SORT_SQL[opts.sort ?? 'started'];
  const dir = opts.dir === 'asc' ? 'asc' : 'desc';
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const [rows, total] = await Promise.all([
    db.sql.query<{ id: string; traffic: Traffic; channel: string; contact: string; status: string; created_at: Date | string; first_message: string | null; last_message: string | null; turns: number; tokens: number; avg_latency_ms: number | null; handoff_reason: string | null; outcome: Outcome }>(
      `select * from (${base}) x ${outcomeFilter} order by ${sortCol.replace('c.created_at', 'x.created_at')} ${dir} nulls last, x.id limit ${limit} offset ${offset}`,
      params,
    ),
    db.sql.query<{ n: number }>(`select count(*)::int as n from (${base}) x ${outcomeFilter}`, params),
  ]);
  return {
    total: n(total.rows[0]?.n),
    rows: rows.rows.map((x) => ({
      id: x.id,
      traffic: x.traffic,
      channel: x.channel,
      contact: maskContact(x.contact),
      status: x.status,
      createdAt: iso(x.created_at),
      firstMessage: x.first_message,
      lastMessage: x.last_message,
      turns: n(x.turns),
      tokens: n(x.tokens),
      avgLatencyMs: nOrNull(x.avg_latency_ms),
      handoffReason: x.handoff_reason,
      outcome: x.outcome,
    })),
  };
}

/* ------------------------------------------------------------ hand-off queue */

export type HandoffItem = {
  id: string;
  conversationId: string;
  reason: string;
  source: 'agent' | 'code';
  summary: string;
  createdAt: string;
  waitingMs: number;
  channel: string;
  contact: string;
  traffic: Traffic;
  lastCustomerMessage: string | null;
};

/** Open escalations on non-eval conversations, oldest first (the order a teammate would work them). */
export async function openHandoffs(db: RelayDb, traffic: Traffic[] = ALL_TRAFFIC): Promise<HandoffItem[]> {
  const r = await db.sql.query<{ id: string; conversation_id: string; reason: string; source: 'agent' | 'code'; summary: string; created_at: Date | string; waiting_ms: number; channel: string; contact: string; traffic: Traffic; last_customer: string | null }>(
    `select e.id, e.conversation_id, e.reason, e.source, e.summary, e.created_at,
            (extract(epoch from (now() - e.created_at)) * 1000)::float8 as waiting_ms,
            c.channel, c.contact, c.traffic,
            (select m.body from messages m where m.conversation_id = c.id and m.role = 'customer' order by m.id desc limit 1) as last_customer
       from escalations e join conversations c on c.id = e.conversation_id
      where e.status = 'open' and c.eval_run_id is null and c.traffic = any($1::text[])
      order by e.created_at`,
    [traffic],
  );
  return r.rows.map((x) => ({
    id: x.id,
    conversationId: x.conversation_id,
    reason: x.reason,
    source: x.source,
    summary: cleanHandoffSummary(x.summary),
    createdAt: iso(x.created_at),
    waitingMs: n(x.waiting_ms),
    channel: x.channel,
    contact: maskContact(x.contact),
    traffic: x.traffic,
    lastCustomerMessage: x.last_customer,
  }));
}
