import Link from 'next/link';
import { notFound } from 'next/navigation';
import { conversationDetail } from '../../../src/monitor/metrics.ts';
import { LocalTime, ThemeToggle } from '../../components/client.tsx';
import { relay } from '../../lib/relay.ts';

export const dynamic = 'force-dynamic';
// Run next to the Neon database (AWS us-east-1); the account default region is Singapore.
export const preferredRegion = 'iad1';

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = await relay();
  const c = await conversationDetail(db, id);
  if (!c) notFound();

  // Interleave: each agent reply is preceded by the tool calls of its turn.
  const agentReplies = c.messages.filter((m) => m.role === 'agent');
  let agentIndex = 0;
  const totalTokens = c.turns.reduce((a, t) => a + t.tokens, 0);

  return (
    <main className="shell">
      <header className="top">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Relay <small>Monitoring</small>
        </Link>
        <ThemeToggle />
      </header>
      <Link href="/" className="back">
        ← All conversations
      </Link>
      <section className="hero">
        <h1 style={{ fontSize: 'clamp(26px, 4vw, 40px)' }}>
          {c.channel.toUpperCase()} {c.contact}
        </h1>
        <div className="facts">
          <span className="chip">{c.traffic}</span>
          <span className="chip">{c.status}</span>
          <span className="chip">{c.model}</span>
          <span className="chip">prompt {c.variant}</span>
          <span className="chip">{totalTokens.toLocaleString('en-US')} tokens</span>
          <span className="chip">
            <LocalTime iso={c.createdAt} />
          </span>
        </div>
      </section>

      <div className="thread">
        {c.messages.map((m, i) => {
          if (m.role === 'customer') {
            return (
              <div key={i} className="bubble customer">
                <span className="who">Customer</span>
                {m.body}
              </div>
            );
          }
          const turn = c.turns[agentIndex];
          agentIndex++;
          return (
            <div key={i} style={{ display: 'contents' }}>
              {turn && turn.tools.length > 0 && (
                <details className="tools">
                  <summary>
                    {turn.tools.length} tool call{turn.tools.length > 1 ? 's' : ''}: {turn.tools.map((t) => t.name).join(', ')} · {(turn.activeLatencyMs / 1000).toFixed(1)} s · {turn.tokens.toLocaleString('en-US')} tokens
                  </summary>
                  <pre>{turn.tools.map((t) => `${t.isError ? '✕ ' : ''}${t.name}(${JSON.stringify(t.input)})\n→ ${JSON.stringify(t.output)}`).join('\n\n')}</pre>
                </details>
              )}
              <div className="bubble agent">
                <span className="who">Relay{turn?.abnormal ? ` · ${turn.abnormal}` : ''}</span>
                {m.body}
              </div>
            </div>
          );
        })}
        {agentReplies.length === 0 && <p className="sub">No reply was logged for this conversation.</p>}
      </div>

      {c.escalations.length > 0 && (
        <>
          <h2 className="section-title">Hand-off</h2>
          {c.escalations.map((e, i) => (
            <div className="card" key={i} style={{ maxWidth: 760, marginBottom: 10 }}>
              <h2>
                {e.reason} · raised by {e.source === 'agent' ? 'the agent' : 'a code safety net'}
              </h2>
              <p className="sub" style={{ fontSize: 13.5, color: 'var(--ink-2)' }}>
                {e.summary}
              </p>
            </div>
          ))}
        </>
      )}
    </main>
  );
}
