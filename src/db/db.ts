// Postgres, two ways, same schema and queries:
//  - locally: PGlite (real Postgres compiled to WASM, in-process, nothing to install)
//  - deployed: any hosted Postgres (Neon free tier) when DATABASE_URL is set, via node-postgres
// The tests run the node-postgres path too, against PGlite served over a socket.

import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolCallRecord } from '../agent/loop.ts';
import type { TokenUsage } from '../agent/pricing.ts';
import type { Channel, ConversationState, EscalationReason } from '../agent/tools.ts';

const SCHEMA = `
create table if not exists conversations (
  id text primary key,
  channel text not null,
  contact text not null,
  status text not null default 'open',          -- open | escalated | closed
  variant text not null,
  model text not null,
  eval_run_id text,
  eval_case_id text,
  state jsonb not null,
  model_messages jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists messages (
  id serial primary key,
  conversation_id text not null references conversations(id),
  role text not null,                            -- customer | agent
  body text not null,
  created_at timestamptz not null default now()
);
create table if not exists turns (
  id serial primary key,
  conversation_id text not null references conversations(id),
  latency_ms real not null,
  active_latency_ms real not null,
  wait_ms real not null,
  steps int not null,
  input_tokens int not null,
  output_tokens int not null,
  cache_read_tokens int not null,
  cache_write_tokens int not null,
  paid_equivalent_usd numeric(12,6),            -- null when the model has no list price on file; real spend on free tiers is 0
  model text not null,
  stop_reason text,
  abnormal text,
  created_at timestamptz not null default now()
);
create table if not exists tool_calls (
  id serial primary key,
  conversation_id text not null references conversations(id),
  turn_id int not null references turns(id),
  seq int not null,
  name text not null,
  input jsonb,
  output jsonb,
  is_error boolean not null,
  duration_ms real not null,
  created_at timestamptz not null default now()
);
create table if not exists escalations (
  id text primary key,
  conversation_id text not null references conversations(id),
  reason text not null,
  source text not null,                          -- agent | code
  summary text not null,
  status text not null default 'open',
  created_at timestamptz not null default now()
);
create table if not exists eval_runs (
  id text primary key,
  label text,
  variant text not null,
  provider text not null,
  model text not null,
  split text not null,
  case_set_hash text not null,
  offline boolean not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb
);
create table if not exists eval_results (
  run_id text not null references eval_runs(id),
  case_id text not null,
  repeat int not null,
  category text not null,
  conversation_id text,
  scores jsonb not null,
  primary key (run_id, case_id, repeat)
);
-- Every inbound webhook event, keyed by the provider's own id, so a provider retry
-- (Twilio retries on timeouts) never runs the agent twice or acts twice.
create table if not exists inbound_events (
  provider text not null,
  external_id text not null,
  conversation_id text,
  reply text,
  created_at timestamptz not null default now(),
  primary key (provider, external_id)
);
-- SMS opt-outs (STOP). Relay never replies to an opted-out number until START.
create table if not exists sms_optouts (
  contact text primary key,
  opted_out_at timestamptz not null default now()
);
-- Milestone 3 (monitoring). live = a real inbound message, synthetic = the scheduled
-- scripted check, demo = sent by hand for a demo. Eval conversations have eval_run_id.
alter table conversations add column if not exists traffic text not null default 'live';
-- A message Relay could not answer (model error, quota, timeout): the customer got the fallback reply.
create table if not exists failures (
  id serial primary key,
  conversation_id text,
  traffic text not null,
  source text not null,
  message text not null,
  created_at timestamptz not null default now()
);
-- Monitoring alerts that fired (and whether they reached Slack).
create table if not exists alerts (
  id serial primary key,
  rule text not null,
  message text not null,
  value double precision,
  threshold double precision,
  posted boolean not null default false,
  created_at timestamptz not null default now()
);
-- Each scheduled synthetic check: scripted dev-split conversations graded by the eval grader.
create table if not exists synthetic_runs (
  id serial primary key,
  passed int not null,
  total int not null,
  errors int not null,
  details jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists conversations_created_idx on conversations (created_at);
create index if not exists turns_created_idx on turns (created_at);
`;

export type Traffic = 'live' | 'synthetic' | 'demo';

/** The part of a Postgres client Relay uses. PGlite and a node-postgres Pool both fit. */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

type Opened = { sql: SqlClient; exec: (text: string) => Promise<unknown>; kind: 'postgres' | 'pglite' };

async function openSql(dir: string): Promise<Opened> {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000 });
    const sql: SqlClient = {
      query: async <T,>(text: string, params?: unknown[]) => ({ rows: (await pool.query(text, params)).rows as T[] }),
      close: () => pool.end(),
    };
    return { sql, exec: (text) => pool.query(text), kind: 'postgres' };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  let db: InstanceType<typeof PGlite>;
  if (dir === 'memory') db = new PGlite();
  else {
    mkdirSync(dir, { recursive: true });
    db = new PGlite(dir);
  }
  const sql: SqlClient = {
    query: async <T,>(text: string, params?: unknown[]) => ({ rows: (await db.query<T>(text, params)).rows }),
    close: () => db.close(),
  };
  return { sql, exec: (text) => db.exec(text), kind: 'pglite' };
}

export type ConversationRow = {
  id: string;
  channel: Channel;
  contact: string;
  status: 'open' | 'escalated' | 'closed';
  variant: string;
  model: string;
  state: ConversationState;
  model_messages: Anthropic.MessageParam[];
};

export class RelayDb {
  private constructor(
    /** Raw SQL access, for monitoring queries and tests. */
    readonly sql: SqlClient,
    /** 'postgres' when DATABASE_URL is set (e.g. Neon), else 'pglite'. */
    readonly kind: 'postgres' | 'pglite',
  ) {}

  /** Uses DATABASE_URL when set. Otherwise PGlite in dir: a folder for a persistent database, or 'memory' for a throwaway one. */
  static async open(dir = process.env.RELAY_DB_DIR ?? '.data/relay-db'): Promise<RelayDb> {
    const { sql, exec, kind } = await openSql(dir);
    try {
      await exec(SCHEMA);
    } catch (err) {
      // Two serverless instances starting at once can race on "create table if not exists"; the retry sees the tables.
      if (kind !== 'postgres') throw err;
      await exec(SCHEMA);
    }
    return new RelayDb(sql, kind);
  }

  close() {
    return this.sql.close();
  }

  private get pg() {
    return this.sql;
  }

  async createConversation(c: { channel: Channel; contact: string; variant: string; model: string; state: ConversationState; evalRunId?: string; evalCaseId?: string; traffic?: Traffic }) {
    const id = `conv_${randomUUID().slice(0, 12)}`;
    await this.pg.query(
      `insert into conversations (id, channel, contact, variant, model, eval_run_id, eval_case_id, state, model_messages, traffic)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'[]'::jsonb,$9)`,
      [id, c.channel, c.contact, c.variant, c.model, c.evalRunId ?? null, c.evalCaseId ?? null, JSON.stringify(c.state), c.traffic ?? 'live'],
    );
    return (await this.getConversation(id))!;
  }

  async getConversation(id: string): Promise<ConversationRow | undefined> {
    const r = await this.pg.query<ConversationRow>(`select * from conversations where id = $1`, [id]);
    return r.rows[0];
  }

  /** Latest non-closed, non-eval conversation for a contact on a channel, of the same kind of traffic. */
  async findOpenConversation(channel: Channel, contact: string, traffic: Traffic = 'live'): Promise<ConversationRow | undefined> {
    const r = await this.pg.query<ConversationRow>(
      `select * from conversations where channel = $1 and contact = $2 and status <> 'closed' and eval_run_id is null and traffic = $3
       order by updated_at desc limit 1`,
      [channel, contact, traffic],
    );
    return r.rows[0];
  }

  async closeConversation(id: string) {
    await this.pg.query(`update conversations set status = 'closed', updated_at = now() where id = $1`, [id]);
  }

  async addMessage(conversationId: string, role: 'customer' | 'agent', body: string) {
    await this.pg.query(`insert into messages (conversation_id, role, body) values ($1,$2,$3)`, [conversationId, role, body]);
  }

  async saveConversationState(id: string, status: ConversationRow['status'], state: ConversationState, messages: Anthropic.MessageParam[]) {
    await this.pg.query(
      `update conversations set status = $2, state = $3::jsonb, model_messages = $4::jsonb, updated_at = now() where id = $1`,
      [id, status, JSON.stringify(state), JSON.stringify(messages)],
    );
  }

  async recordTurn(t: { conversationId: string; latencyMs: number; activeLatencyMs: number; waitMs: number; steps: number; usage: TokenUsage; paidEquivalentUsd: number | null; model: string; stopReason: string | null; abnormal: string | null; toolCalls: ToolCallRecord[] }) {
    const r = await this.pg.query<{ id: number }>(
      `insert into turns (conversation_id, latency_ms, active_latency_ms, wait_ms, steps, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, paid_equivalent_usd, model, stop_reason, abnormal)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [t.conversationId, t.latencyMs, t.activeLatencyMs, t.waitMs, t.steps, t.usage.inputTokens, t.usage.outputTokens, t.usage.cacheReadTokens, t.usage.cacheWriteTokens, t.paidEquivalentUsd, t.model, t.stopReason, t.abnormal],
    );
    const turnId = r.rows[0].id;
    for (const c of t.toolCalls) {
      await this.pg.query(
        `insert into tool_calls (conversation_id, turn_id, seq, name, input, output, is_error, duration_ms) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
        [t.conversationId, turnId, c.seq, c.name, JSON.stringify(c.input ?? null), JSON.stringify(c.output ?? null), c.isError, c.durationMs],
      );
    }
    return turnId;
  }

  async createEscalation(e: { conversationId: string; reason: EscalationReason; source: 'agent' | 'code'; summary: string }) {
    const id = `esc_${randomUUID().slice(0, 8)}`;
    await this.pg.query(`insert into escalations (id, conversation_id, reason, source, summary) values ($1,$2,$3,$4,$5)`, [id, e.conversationId, e.reason, e.source, e.summary]);
    return id;
  }

  async openEscalations(includeEval = false) {
    const r = await this.pg.query<{ id: string; conversation_id: string; reason: string; source: string; summary: string; created_at: string; channel: string; contact: string }>(
      `select e.*, c.channel, c.contact from escalations e join conversations c on c.id = e.conversation_id
       where e.status = 'open' ${includeEval ? '' : 'and c.eval_run_id is null'} order by e.created_at`,
    );
    return r.rows;
  }

  async transcript(conversationId: string) {
    const r = await this.pg.query<{ role: string; body: string; created_at: string }>(
      `select role, body, created_at from messages where conversation_id = $1 order by id`,
      [conversationId],
    );
    return r.rows;
  }

  async createEvalRun(r: { id: string; label?: string; variant: string; provider: string; model: string; split: string; caseSetHash: string; offline: boolean }) {
    await this.pg.query(
      `insert into eval_runs (id, label, variant, provider, model, split, case_set_hash, offline) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing`,
      [r.id, r.label ?? null, r.variant, r.provider, r.model, r.split, r.caseSetHash, r.offline],
    );
  }

  async finishEvalRun(id: string, summary: unknown) {
    await this.pg.query(`update eval_runs set finished_at = now(), summary = $2::jsonb where id = $1`, [id, JSON.stringify(summary)]);
  }

  async recordEvalResult(r: { runId: string; caseId: string; repeat: number; category: string; conversationId?: string; scores: unknown }) {
    await this.pg.query(
      `insert into eval_results (run_id, case_id, repeat, category, conversation_id, scores) values ($1,$2,$3,$4,$5,$6::jsonb)
       on conflict (run_id, case_id, repeat) do update set scores = excluded.scores, conversation_id = excluded.conversation_id`,
      [r.runId, r.caseId, r.repeat, r.category, r.conversationId ?? null, JSON.stringify(r.scores)],
    );
  }

  /** Claim an inbound event. Returns the earlier record if this event was already handled (a retry). */
  async claimInboundEvent(provider: string, externalId: string): Promise<{ duplicate: false } | { duplicate: true; reply: string | null }> {
    const r = await this.pg.query<{ reply: string | null }>(
      `insert into inbound_events (provider, external_id) values ($1, $2) on conflict do nothing returning reply`,
      [provider, externalId],
    );
    if (r.rows.length) return { duplicate: false };
    const prev = await this.pg.query<{ reply: string | null }>(`select reply from inbound_events where provider = $1 and external_id = $2`, [provider, externalId]);
    return { duplicate: true, reply: prev.rows[0]?.reply ?? null };
  }

  async completeInboundEvent(provider: string, externalId: string, conversationId: string | null, reply: string | null) {
    await this.pg.query(`update inbound_events set conversation_id = $3, reply = $4 where provider = $1 and external_id = $2`, [provider, externalId, conversationId, reply]);
  }

  async setSmsOptOut(contact: string, optedOut: boolean) {
    if (optedOut) await this.pg.query(`insert into sms_optouts (contact) values ($1) on conflict do nothing`, [contact]);
    else await this.pg.query(`delete from sms_optouts where contact = $1`, [contact]);
  }

  async recordFailure(f: { conversationId?: string | null; traffic: Traffic; source: string; message: string }) {
    await this.pg.query(`insert into failures (conversation_id, traffic, source, message) values ($1,$2,$3,$4)`, [f.conversationId ?? null, f.traffic, f.source, f.message.slice(0, 1000)]);
  }

  async recordAlert(a: { rule: string; message: string; value: number | null; threshold: number | null; posted: boolean }) {
    await this.pg.query(`insert into alerts (rule, message, value, threshold, posted) values ($1,$2,$3,$4,$5)`, [a.rule, a.message, a.value, a.threshold, a.posted]);
  }

  async recordSyntheticRun(r: { passed: number; total: number; errors: number; details: unknown }) {
    await this.pg.query(`insert into synthetic_runs (passed, total, errors, details) values ($1,$2,$3,$4::jsonb)`, [r.passed, r.total, r.errors, JSON.stringify(r.details)]);
  }

  /** When this rule last fired, or null. */
  async lastAlertAt(rule: string): Promise<Date | null> {
    const r = await this.pg.query<{ at: Date | string | null }>(`select max(created_at) as at from alerts where rule = $1`, [rule]);
    const at = r.rows[0]?.at;
    return at ? new Date(at) : null;
  }

  async isSmsOptedOut(contact: string): Promise<boolean> {
    const r = await this.pg.query(`select 1 from sms_optouts where contact = $1`, [contact]);
    return r.rows.length > 0;
  }
}
