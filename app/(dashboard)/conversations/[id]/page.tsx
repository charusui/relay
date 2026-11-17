import { ArrowLeft, Bot, Hand, User } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LocalTime } from '@/components/relay/client';
import { ToolCall } from '@/components/relay/tool-call';
import { fmt, OutcomeBadge, ReasonBadge, TrafficBadge } from '@/components/relay/ui';
import { filterQuery, type SearchParams } from '@/lib/filters';
import { cn } from '@/lib/utils';
import { conversationDetail } from '../../../../src/monitor/metrics.ts';
import { relay } from '../../../lib/relay.ts';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'iad1';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: (await params).id };
}

export default async function ConversationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const { db } = await relay();
  const c = await conversationDetail(db, id);
  if (!c) notFound();

  const customerCount = c.messages.filter((m) => m.role === 'customer').length;
  const agentCount = c.messages.filter((m) => m.role === 'agent').length;
  const outcome = c.escalations.length ? 'handed_off' : customerCount > agentCount ? 'failed' : 'answered';
  const totalTokens = c.turns.reduce((a, t) => a + t.tokens, 0);
  const latencies = c.turns.map((t) => t.activeLatencyMs);
  const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  const toolCount = c.turns.reduce((a, t) => a + t.tools.length, 0);

  // Each agent message is preceded by the tool calls of its turn.
  let turnIndex = 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="icon" className="size-8 shrink-0" aria-label="Back to conversations">
            <Link href={`/conversations${filterQuery(sp)}`}>
              <ArrowLeft />
            </Link>
          </Button>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
              <span className="font-mono text-base">{c.channel.toUpperCase()}</span>
              <span className="truncate font-mono text-base text-muted-foreground">{c.contact}</span>
            </h1>
            <p className="font-mono text-xs text-muted-foreground">{c.id}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <TrafficBadge traffic={c.traffic} />
          <OutcomeBadge outcome={outcome} reason={c.escalations[0]?.reason} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Thread</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="relative flex flex-col gap-4 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-border">
              {c.messages.map((m, i) => {
                const isAgent = m.role === 'agent';
                const turn = isAgent ? c.turns[turnIndex++] : undefined;
                return (
                  <li key={i} className="relative flex gap-3">
                    <span className={cn('z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-background', isAgent && 'bg-foreground text-background')}>
                      {isAgent ? <Bot className="size-4" /> : <User className="size-4 text-muted-foreground" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                        <span className="font-medium">{isAgent ? 'Relay' : 'Customer'}</span>
                        <span className="text-muted-foreground">
                          <LocalTime iso={m.at} />
                        </span>
                        {turn && (
                          <span className="tabular text-muted-foreground">
                            · {fmt.secs(turn.activeLatencyMs)} s · {fmt.int(turn.tokens)} tokens · {turn.steps} model call{turn.steps === 1 ? '' : 's'}
                          </span>
                        )}
                        {turn?.abnormal && <span className="font-medium text-destructive">· {turn.abnormal.replace(/_/g, ' ')}</span>}
                      </div>
                      {turn && turn.tools.length > 0 && (
                        <div className="mt-2 flex flex-col gap-1.5">
                          {turn.tools.map((t, j) => (
                            <ToolCall key={j} {...t} />
                          ))}
                        </div>
                      )}
                      <div className={cn('mt-2 rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap', isAgent ? 'bg-muted/40' : 'bg-background')}>{m.body}</div>
                    </div>
                  </li>
                );
              })}
            </ol>
            {customerCount > agentCount && (
              <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">The last message got no reply from the agent: the model call failed and the customer received the fallback text.</p>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
                <Row label="Started">
                  <LocalTime iso={c.createdAt} />
                </Row>
                <Row label="Status">
                  <span className="capitalize">{c.status}</span>
                </Row>
                <Row label="Replies">{agentCount}</Row>
                <Row label="Tool calls">{toolCount}</Row>
                <Row label="Avg reply">{avgLatency === null ? '–' : `${fmt.secs(avgLatency)} s`}</Row>
                <Row label="Tokens">{fmt.int(totalTokens)}</Row>
                <Row label="Prompt">
                  <span className="font-mono text-xs">{c.variant}</span>
                </Row>
                <Row label="Model">
                  <span className="font-mono text-xs break-all">{c.model}</span>
                </Row>
              </dl>
            </CardContent>
          </Card>

          {c.escalations.map((e, i) => (
            <Card key={i} className="shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Hand className="size-4 text-chart-2" /> Handed to a person
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <ReasonBadge reason={e.reason} source={e.source as 'agent' | 'code'} />
                <p className="text-sm leading-relaxed text-muted-foreground">{e.summary}</p>
                <p className="text-xs text-muted-foreground">
                  <LocalTime iso={e.at} />
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular min-w-0 text-right">{children}</dd>
    </>
  );
}
