import Link from 'next/link';
import type { Traffic } from '../src/db/db.ts';
import { RULES, COOLDOWN_HOURS } from '../src/monitor/alerts.ts';
import { ALL_TRAFFIC, daily, recentAlerts, recentConversations, recentSyntheticRuns, summary } from '../src/monitor/metrics.ts';
import { SYNTHETIC_CASE_IDS } from '../src/monitor/synthetic.ts';
import { DailyConversations, DailyLine, LocalTime, ThemeToggle } from './components/client.tsx';
import { relay } from './lib/relay.ts';

export const dynamic = 'force-dynamic';
// Run next to the Neon database (AWS us-east-1); the account default region is Singapore.
export const preferredRegion = 'iad1';

const WINDOWS = [
  { id: '24h', label: '24 hours', hours: 24, days: 7 },
  { id: '7d', label: '7 days', hours: 24 * 7, days: 7 },
  { id: '30d', label: '30 days', hours: 24 * 30, days: 30 },
] as const;

const TRAFFIC_FILTERS: { id: string; label: string; traffic: Traffic[] }[] = [
  { id: 'all', label: 'All', traffic: ALL_TRAFFIC },
  { id: 'demo', label: 'Demo', traffic: ['demo'] },
  { id: 'synthetic', label: 'Synthetic', traffic: ['synthetic'] },
  { id: 'live', label: 'Live', traffic: ['live'] },
];

const REASON_LABEL: Record<string, string> = {
  angry_customer: 'Upset or asked for a person',
  refund_over_threshold: 'Refund over $150',
  low_confidence: 'Could not answer confidently',
};

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}`);
const secs = (ms: number | null) => (ms === null ? '–' : (ms / 1000).toFixed(1));
const int = (x: number | null) => (x === null ? '–' : Math.round(x).toLocaleString('en-US'));

type Search = Promise<{ window?: string; traffic?: string }>;

export default async function Dashboard({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const win = WINDOWS.find((w) => w.id === sp.window) ?? WINDOWS[1];
  const tf = TRAFFIC_FILTERS.find((t) => t.id === sp.traffic) ?? TRAFFIC_FILTERS[0];
  const href = (w: string, t: string) => `/?window=${w}&traffic=${t}`;

  let data;
  try {
    const { db, info } = await relay();
    const [s, days, convs, alerts, checks] = await Promise.all([
      summary(db, { hours: win.hours, traffic: tf.traffic }),
      daily(db, win.days, tf.traffic),
      recentConversations(db, 20, tf.traffic),
      recentAlerts(db, 12),
      recentSyntheticRuns(db, 7),
    ]);
    data = { s, days, convs, alerts, checks, info };
  } catch (err) {
    return (
      <main className="shell">
        <Header />
        <div className="card" style={{ marginTop: 24 }}>
          <h2>The dashboard can&apos;t reach its database</h2>
          <p className="sub">{(err as Error).message.slice(0, 300)}</p>
        </div>
      </main>
    );
  }
  const { s, days, convs, alerts, checks, info } = data;
  const maxReason = Math.max(1, ...s.handoffReasons.map((r) => r.n));
  const hasTraffic = s.conversations > 0 || s.failures > 0;

  return (
    <main className="shell">
      <Header meta={`${info.model} · ${info.variant}`} />

      <section className="hero">
        <h1>
          Is Relay behaving
          <br />
          right now?
        </h1>
        <p>
          Every customer message Relay handles is logged with its reply time, tokens, tool calls and whether a person had to take over. A scripted check runs once a day and is graded by the same grader as the eval suite.
        </p>
        <div className="note" role="note">
          <span aria-hidden="true">ⓘ</span>
          <span>
            <b>Not real customers.</b> The store is fictional. Traffic here is the daily synthetic check and demo texts sent by the developer, labelled as such. Accuracy is measured offline on a frozen test set, not on this page.
          </span>
        </div>
      </section>

      <nav className="filters" aria-label="Filters">
        <div>
          <span className="filter-label">Window</span>
          <span className="seg">
            {WINDOWS.map((w) => (
              <Link key={w.id} href={href(w.id, tf.id)} aria-current={w.id === win.id} scroll={false}>
                {w.label}
              </Link>
            ))}
          </span>
        </div>
        <div>
          <span className="filter-label">Traffic</span>
          <span className="seg">
            {TRAFFIC_FILTERS.map((t) => (
              <Link key={t.id} href={href(win.id, t.id)} aria-current={t.id === tf.id} scroll={false}>
                {t.label}
              </Link>
            ))}
          </span>
        </div>
      </nav>

      <section className="grid kpis" aria-label={`Totals for the last ${win.label}`}>
        <Kpi label="Conversations" value={int(s.conversations)} foot={`${int(s.customerMessages)} customer messages`} />
        <Kpi label="Handed to a person" value={pct(s.handoffRate)} unit={s.handoffRate === null ? '' : '%'} foot={`${s.handoffs} conversation${s.handoffs === 1 ? '' : 's'} · ${s.handoffsBySource.agent} by the agent, ${s.handoffsBySource.code} by a safety net`} />
        <Kpi label="Failed messages" value={pct(s.errorRate)} unit={s.errorRate === null ? '' : '%'} foot={`${s.failures} got the fallback reply`} />
        <Kpi label="Reply time p50 / p95" value={`${secs(s.latencyP50Ms)} / ${secs(s.latencyP95Ms)}`} unit={s.latencyP50Ms === null ? '' : 's'} foot="Rate-limit waits excluded" />
        <Kpi label="Tokens per conversation" value={int(s.avgTokensPerConversation)} foot={`${int(s.avgTokensPerTurn)} per reply`} />
        <Kpi label="Model cost" value="$0" foot="Free tiers only" />
      </section>

      <section className="grid two">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Conversations per day</h2>
              <p className="sub">Last {win.days} days, by day started (UTC)</p>
            </div>
            <div className="legend" aria-label="Legend">
              <span>
                <i className="swatch" style={{ background: 'var(--series-1)' }} />
                Answered by Relay
              </span>
              <span>
                <i className="swatch" style={{ background: 'var(--series-2)' }} />
                Handed to a person
              </span>
            </div>
          </div>
          {days.some((d) => d.conversations > 0) ? (
            <DailyConversations days={days.map((d) => ({ day: d.day, answered: Math.max(0, d.conversations - d.handoffs), handedOff: Math.min(d.handoffs, d.conversations), failures: d.failures }))} />
          ) : (
            <div className="empty">No conversations in this window yet.</div>
          )}
          <details className="table-view">
            <summary>Table view</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Day (UTC)</th>
                    <th className="num">Conversations</th>
                    <th className="num">Handed off</th>
                    <th className="num">Failed messages</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.day}>
                      <td>{d.day}</td>
                      <td className="num">{d.conversations}</td>
                      <td className="num">{d.handoffs}</td>
                      <td className="num">{d.failures}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Why conversations were handed off</h2>
              <p className="sub">Last {win.label}</p>
            </div>
          </div>
          {s.handoffReasons.length ? (
            <div className="hbars">
              {s.handoffReasons.map((r) => (
                <div className="hbar" key={r.reason}>
                  <div className="top-line">
                    <span>{REASON_LABEL[r.reason] ?? r.reason}</span>
                    <b>{r.n}</b>
                  </div>
                  <div className="track">
                    <div className="fill" style={{ width: `${(r.n / maxReason) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">No hand-offs in this window.</div>
          )}
        </div>
      </section>

      <section className="grid two even">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Reply time, p95</h2>
              <p className="sub">Seconds per reply, rate-limit waits excluded. Free tier, so it swings.</p>
            </div>
          </div>
          {days.some((d) => d.p95Ms !== null) ? <DailyLine points={days.map((d) => ({ day: d.day, value: d.p95Ms === null ? null : d.p95Ms / 1000 }))} label="p95 reply time" unit="seconds" /> : <div className="empty">No replies in this window yet.</div>}
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Tokens per reply</h2>
              <p className="sub">Average input + output tokens. A jump means prompts or tool results grew.</p>
            </div>
          </div>
          {days.some((d) => d.avgTokensPerTurn !== null) ? <DailyLine points={days.map((d) => ({ day: d.day, value: d.avgTokensPerTurn }))} label="Tokens per reply" unit="tokens" /> : <div className="empty">No replies in this window yet.</div>}
        </div>
      </section>

      <h2 className="section-title">Checks and alerts</h2>
      <section className="grid two even">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Daily synthetic check</h2>
              <p className="sub">
                {SYNTHETIC_CASE_IDS.length} scripted conversations from the dev split (tracking, a return, a policy answer, an injection attempt, a hand-off), graded by the eval grader.
              </p>
            </div>
          </div>
          {checks.length ? (
            <div className="checks">
              {checks.map((c) => {
                const ok = c.passed === c.total;
                const failing = c.details.filter((d) => !d.pass);
                return (
                  <div className="check" key={c.id}>
                    <span className={`chip ${ok ? 'good' : 'bad'}`}>
                      <span aria-hidden="true">{ok ? '✓' : '✕'}</span>
                      {ok ? 'Pass' : 'Fail'}
                    </span>
                    <div>
                      <div>
                        {c.passed}/{c.total} passed{c.errors ? ` · ${c.errors} errored` : ''}
                      </div>
                      {failing.length > 0 && <div className="detail">{failing.map((f) => `${f.caseId}: ${f.error ? 'error' : f.reasons[0] ?? 'failed'}`).join(' · ')}</div>}
                    </div>
                    <span className="detail">
                      <LocalTime iso={c.at} mode="relative" />
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty">No synthetic check has run yet.</div>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Alerts</h2>
              <p className="sub">Posted to Slack when configured. Each rule fires at most once every {COOLDOWN_HOURS} hours.</p>
            </div>
          </div>
          {alerts.length ? (
            alerts.map((a, i) => (
              <div className="alert-row" key={i}>
                <div>{a.message}</div>
                <div className="meta">
                  {a.rule} · <LocalTime iso={a.at} /> · {a.posted ? 'sent to Slack' : 'not sent to Slack'}
                </div>
              </div>
            ))
          ) : (
            <div className="empty">No alerts have fired.</div>
          )}
          <details className="table-view">
            <summary>Alert rules (starting thresholds, not tuned yet)</summary>
            <ul className="rules">
              {RULES.map((r) => (
                <li key={r.id}>{r.describe}</li>
              ))}
              <li>Any failing case in the daily synthetic check</li>
            </ul>
          </details>
        </div>
      </section>

      <h2 className="section-title">Recent conversations</h2>
      <section className="card">
        {convs.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Kind</th>
                  <th>Customer</th>
                  <th>First message</th>
                  <th>Outcome</th>
                  <th className="num">Replies</th>
                  <th className="num">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {convs.map((c) => (
                  <tr key={c.id} className="link">
                    <td>
                      <Link className="row-link" href={`/conversations/${c.id}`}>
                        <LocalTime iso={c.createdAt} />
                      </Link>
                    </td>
                    <td>
                      <span className="chip">{c.traffic}</span>
                    </td>
                    <td>
                      {c.channel.toUpperCase()} {c.contact}
                    </td>
                    <td>
                      <div className="clip">{c.firstMessage ?? '–'}</div>
                    </td>
                    <td>{c.handoffReason ? <span className="chip">Handed off · {REASON_LABEL[c.handoffReason] ?? c.handoffReason}</span> : <span className="chip">Answered by Relay</span>}</td>
                    <td className="num">{c.turns}</td>
                    <td className="num">{c.tokens.toLocaleString('en-US')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No conversations yet.</div>
        )}
      </section>

      <footer className="footer">
        {hasTraffic ? null : 'Nothing logged in this window yet. '}
        Database: {info.database}. Store: {info.store}. Phone numbers and emails are masked. Times on this page are in your local time zone; daily charts use UTC days.
      </footer>
    </main>
  );
}

function Header({ meta }: { meta?: string }) {
  return (
    <header className="top">
      <Link href="/" className="brand">
        <span className="brand-mark" aria-hidden="true" />
        Relay <small>Monitoring</small>
      </Link>
      <div className="top-meta">
        {meta && <span>{meta}</span>}
        <ThemeToggle />
      </div>
    </header>
  );
}

function Kpi({ label, value, unit, foot }: { label: string; value: string; unit?: string; foot: string }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      <div className="foot">{foot}</div>
    </div>
  );
}
