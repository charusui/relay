import { ArrowRight, BellRing, CheckCircle2, Inbox, MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LocalTime, TrendChart, VolumeChart } from '@/components/relay/client';
import { ConversationsTable } from '@/components/relay/conversations-table';
import { EmptyState, fmt, Kpi, PageHeader, PassBadge, ReasonBadge, type Delta } from '@/components/relay/ui';
import { filterQuery, parseRange, parseTraffic, type SearchParams } from '@/lib/filters';
import { cn } from '@/lib/utils';
import { daily, listConversations, openHandoffs, recentAlerts, recentSyntheticRuns, summary } from '../../src/monitor/metrics.ts';
import { relay } from '../lib/relay.ts';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'iad1';
export const metadata = { title: 'Overview' };

/** Relative change, or null when there is nothing to compare against. */
function rel(cur: number | null, prev: number | null): number {
  if (cur === null || prev === null || prev === 0) return Number.NaN;
  return (cur - prev) / prev;
}
function diff(cur: number | null, prev: number | null): number {
  if (cur === null || prev === null) return Number.NaN;
  return cur - prev;
}
const pctFmt = (v: number) => `${(v * 100).toFixed(0)}%`;
const ppFmt = (v: number) => `${(v * 100).toFixed(1).replace(/\.0$/, '')} pts`;
const secFmt = (v: number) => `${(v / 1000).toFixed(1)} s`;

export default async function OverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = parseRange(sp);
  const tf = parseTraffic(sp);
  const qs = filterQuery(sp);
  const { db } = await relay();

  const [s, prev, days, recent, queue, runs, alerts] = await Promise.all([
    summary(db, { hours: range.hours, traffic: tf.traffic }),
    summary(db, { hours: range.hours, traffic: tf.traffic, offsetHours: range.hours }),
    daily(db, range.days, tf.traffic),
    listConversations(db, { hours: range.hours, traffic: tf.traffic, limit: 8 }),
    openHandoffs(db, tf.traffic),
    recentSyntheticRuns(db, 14),
    recentAlerts(db, 5),
  ]);

  const hadPrev = prev.conversations > 0 || prev.failures > 0;
  const d = (value: number, better: 'up' | 'down' | 'none', format: (v: number) => string): Delta => (hadPrev ? { value, better, format } : null);
  const lastRun = runs[0];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Overview"
        description={
          <>
            {range.label}, {tf.label.toLowerCase()}. Changes compare with the {range.short} before.
          </>
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/conversations${qs}`}>
              <MessagesSquare /> All conversations
            </Link>
          </Button>
        }
      />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Key metrics">
        <Kpi label="Conversations" value={fmt.int(s.conversations)} hint={`${fmt.int(s.customerMessages)} messages`} delta={d(rel(s.conversations, prev.conversations), 'none', pctFmt)} spark={days.map((x) => x.conversations)} />
        <Kpi
          label="Hand-off rate"
          info="Share of conversations handed to a person, by the agent itself or by a code safety net (asked for a person, repeated complaint, refund over $150)."
          value={fmt.pct(s.handoffRate)}
          unit={s.handoffRate === null ? undefined : '%'}
          hint={`${s.handoffsBySource.agent} agent · ${s.handoffsBySource.code} rule`}
          delta={d(diff(s.handoffRate, prev.handoffRate), 'down', ppFmt)}
          spark={days.map((x) => (x.conversations ? x.handoffs / x.conversations : null))}
        />
        <Kpi
          label="Failed messages"
          info="Customer messages that got the fallback reply because the model call failed (quota, provider error or timeout)."
          value={fmt.pct(s.errorRate)}
          unit={s.errorRate === null ? undefined : '%'}
          hint={`${s.failures} of ${s.turns + s.failures} messages`}
          delta={d(diff(s.errorRate, prev.errorRate), 'down', ppFmt)}
          spark={days.map((x) => (x.turns + x.failures ? x.failures / (x.turns + x.failures) : null))}
        />
        <Kpi
          label="Reply time p95"
          info="95th percentile time to reply, excluding time spent waiting on the free tier's rate limit."
          value={fmt.secs(s.latencyP95Ms)}
          unit={s.latencyP95Ms === null ? undefined : 's'}
          hint={`p50 ${fmt.secs(s.latencyP50Ms)} s`}
          delta={d(diff(s.latencyP95Ms, prev.latencyP95Ms), 'down', secFmt)}
          spark={days.map((x) => x.p95Ms)}
        />
        <Kpi
          label="Tokens / conversation"
          value={fmt.int(s.avgTokensPerConversation)}
          hint={`${fmt.int(s.avgTokensPerTurn)} per reply`}
          delta={d(rel(s.avgTokensPerConversation, prev.avgTokensPerConversation), 'down', pctFmt)}
          spark={days.map((x) => x.avgTokensPerTurn)}
        />
        <Kpi label="Model cost" info="Relay runs on free tiers (Gemini free API, Vercel Hobby, Neon Free). Paid-equivalent cost isn't shown because the model has no published list price on file." value="$0" hint="Free tiers only" />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="shadow-none lg:col-span-2">
          <CardHeader>
            <CardTitle>Conversations per day</CardTitle>
            <CardDescription>Last {range.days} days by the day each conversation started (UTC)</CardDescription>
          </CardHeader>
          <CardContent>
            {days.some((x) => x.conversations > 0) ? (
              <VolumeChart data={days.map((x) => ({ day: x.day, answered: Math.max(0, x.conversations - x.handoffs), handedOff: Math.min(x.handoffs, x.conversations) }))} />
            ) : (
              <EmptyState icon={<MessagesSquare />} title="No conversations in this period" className="h-[220px]">
                Demo texts and the daily synthetic check appear here.
              </EmptyState>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Hand-off queue</CardTitle>
            <CardDescription>Waiting for a person, oldest first</CardDescription>
            <CardAction>
              <Button asChild variant="ghost" size="sm" className="-mr-2 h-7 text-xs">
                <Link href={`/handoffs${qs}`}>
                  View all <ArrowRight />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {queue.length ? (
              queue.slice(0, 4).map((h) => (
                <Link key={h.id} href={`/conversations/${h.conversationId}${qs}`} className="rounded-lg border p-3 transition-colors hover:bg-muted/50">
                  <div className="flex items-center justify-between gap-2">
                    <ReasonBadge reason={h.reason} />
                    <span className="tabular shrink-0 text-xs text-muted-foreground">{fmt.duration(h.waitingMs)}</span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{h.lastCustomerMessage ?? h.summary}</p>
                </Link>
              ))
            ) : (
              <EmptyState icon={<Inbox />} title="Nobody is waiting">
                Hand-offs appear here until a teammate takes them.
              </EmptyState>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Reply time p95</CardTitle>
            <CardDescription>Seconds, rate-limit waits excluded</CardDescription>
          </CardHeader>
          <CardContent>
            {days.some((x) => x.p95Ms !== null) ? <TrendChart unit="seconds" label="p95 reply time" data={days.map((x) => ({ day: x.day, value: x.p95Ms === null ? null : x.p95Ms / 1000 }))} /> : <EmptyState title="No replies in this period" className="h-[180px]" />}
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Tokens per reply</CardTitle>
            <CardDescription>A jump means prompts or tool results grew</CardDescription>
          </CardHeader>
          <CardContent>
            {days.some((x) => x.avgTokensPerTurn !== null) ? <TrendChart unit="tokens" label="Tokens per reply" data={days.map((x) => ({ day: x.day, value: x.avgTokensPerTurn }))} /> : <EmptyState title="No replies in this period" className="h-[180px]" />}
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Daily synthetic check</CardTitle>
            <CardDescription>5 scripted conversations, graded like the evals</CardDescription>
            <CardAction>
              <Button asChild variant="ghost" size="sm" className="-mr-2 h-7 text-xs">
                <Link href={`/alerts${qs}`}>
                  Details <ArrowRight />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {lastRun ? (
              <>
                <div className="flex items-center justify-between">
                  <PassBadge pass={lastRun.passed === lastRun.total}>
                    {lastRun.passed}/{lastRun.total} passed
                  </PassBadge>
                  <span className="text-xs text-muted-foreground">
                    <LocalTime iso={lastRun.at} mode="relative" />
                  </span>
                </div>
                <div>
                  <div className="flex gap-1" role="list" aria-label="Recent daily checks, oldest to newest">
                    {[...runs].reverse().map((r) => (
                      <Tooltip key={r.id}>
                        <TooltipTrigger asChild>
                          <span role="listitem" className={cn('h-7 flex-1 rounded-sm', r.passed === r.total ? 'bg-success/70' : 'bg-destructive/70')} aria-label={`${r.passed} of ${r.total} passed`} />
                        </TooltipTrigger>
                        <TooltipContent>
                          {r.passed}/{r.total} passed · <LocalTime iso={r.at} />
                        </TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{runs.length === 1 ? 'First check so far' : `Last ${runs.length} checks, oldest first`}</p>
                </div>
                {alerts[0] && (
                  <div className="flex items-start gap-2 rounded-lg border p-3 text-xs">
                    <BellRing className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="line-clamp-2">{alerts[0].message}</p>
                      <p className="mt-1 text-muted-foreground">
                        Latest alert · <LocalTime iso={alerts[0].at} mode="relative" />
                      </p>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <EmptyState icon={<CheckCircle2 />} title="No check has run yet">
                It runs every day at 09:00 UTC.
              </EmptyState>
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="gap-0 overflow-hidden py-0 shadow-none">
        <CardHeader className="border-b py-4">
          <CardTitle>Recent conversations</CardTitle>
          <CardDescription>The latest {recent.rows.length} of {recent.total} in this period</CardDescription>
          <CardAction>
            <Button asChild variant="ghost" size="sm" className="-mr-2 h-7 text-xs">
              <Link href={`/conversations${qs}`}>
                View all <ArrowRight />
              </Link>
            </Button>
          </CardAction>
        </CardHeader>
        {recent.rows.length ? (
          <ConversationsTable rows={recent.rows} qs={qs} compact />
        ) : (
          <div className="p-4">
            <EmptyState icon={<MessagesSquare />} title="No conversations yet" />
          </div>
        )}
      </Card>
    </div>
  );
}
