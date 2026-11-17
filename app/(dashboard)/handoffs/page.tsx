import { ArrowUpRight, Inbox } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { LocalTime } from '@/components/relay/client';
import { EmptyState, fmt, PageHeader, reasonLabel, ReasonBadge, TrafficBadge } from '@/components/relay/ui';
import { filterQuery, parseTraffic, type SearchParams } from '@/lib/filters';
import { openHandoffs } from '../../../src/monitor/metrics.ts';
import { relay } from '../../lib/relay.ts';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'iad1';
export const metadata = { title: 'Hand-offs' };

export default async function HandoffsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const tf = parseTraffic(sp);
  const qs = filterQuery(sp);
  const { db } = await relay();
  const queue = await openHandoffs(db, tf.traffic);
  const byReason = Object.entries(queue.reduce<Record<string, number>>((acc, h) => ((acc[h.reason] = (acc[h.reason] ?? 0) + 1), acc), {})).sort((a, b) => b[1] - a[1]);
  const oldest = queue[0];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Hand-offs"
        description="Conversations Relay passed to a person, oldest first: the order a teammate would work them. Each was also posted to Slack with the agent's summary. This view is read-only."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Waiting" value={String(queue.length)} />
        <Stat label="Longest wait" value={oldest ? fmt.duration(oldest.waitingMs) : '–'} />
        <Stat label="Raised by the agent" value={String(queue.filter((h) => h.source === 'agent').length)} />
        <Stat label="Raised by a safety net" value={String(queue.filter((h) => h.source === 'code').length)} />
      </div>

      {byReason.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {byReason.map(([reason, count]) => (
            <Badge key={reason} variant="secondary" className="tabular font-normal">
              {reasonLabel(reason)} · {count}
            </Badge>
          ))}
        </div>
      )}

      {queue.length ? (
        <div className="flex flex-col gap-3">
          {queue.map((h) => (
            <Card key={h.id} className="gap-0 py-0 shadow-none transition-colors hover:bg-muted/30">
              <CardContent className="relative flex flex-col gap-3 p-4 md:flex-row md:items-start md:gap-6">
                <div className="flex shrink-0 flex-col gap-2 md:w-64">
                  <ReasonBadge reason={h.reason} source={h.source} />
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{h.channel.toUpperCase()}</span>
                    <span className="font-mono">{h.contact}</span>
                    <TrafficBadge traffic={h.traffic} />
                  </div>
                  <p className="tabular text-xs text-muted-foreground">
                    Waiting {fmt.duration(h.waitingMs)} · <LocalTime iso={h.createdAt} />
                  </p>
                </div>
                <div className="min-w-0 flex-1">
                  {h.lastCustomerMessage && <p className="text-sm">“{h.lastCustomerMessage}”</p>}
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{h.summary}</p>
                </div>
                <Link href={`/conversations/${h.conversationId}${qs}`} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring">
                  Open thread <ArrowUpRight className="size-3.5" />
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState icon={<Inbox />} title="Nobody is waiting for a person">
          When Relay hands a conversation off (an upset customer, a refund over $150, or a question it can&apos;t answer from the policies), it waits here until a teammate takes it.
        </EmptyState>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="gap-1 py-3 shadow-none">
      <CardContent className="px-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="tabular mt-1 text-xl font-semibold tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}
