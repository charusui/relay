import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConversationsTable } from '@/components/relay/conversations-table';
import { ConversationControls } from '@/components/relay/list-controls';
import { EmptyState, PageHeader } from '@/components/relay/ui';
import { filterQuery, param, parseRange, parseTraffic, type SearchParams } from '@/lib/filters';
import { listConversations, type ConversationSort, type Outcome } from '../../../src/monitor/metrics.ts';
import { relay } from '../../lib/relay.ts';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'iad1';
export const metadata = { title: 'Conversations' };

const PAGE_SIZE = 25;
const SORTS: ConversationSort[] = ['started', 'replies', 'tokens', 'latency'];
const OUTCOMES: Outcome[] = ['answered', 'handed_off', 'failed'];

export default async function ConversationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = parseRange(sp);
  const tf = parseTraffic(sp);
  const q = param(sp, 'q');
  const outcome = OUTCOMES.find((o) => o === param(sp, 'outcome'));
  const channel = (['sms', 'email'] as const).find((c) => c === param(sp, 'channel'));
  const sort = SORTS.find((s) => s === param(sp, 'sort')) ?? 'started';
  const dir = param(sp, 'dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(param(sp, 'page')) || 1);

  const { db } = await relay();
  const { rows, total } = await listConversations(db, { hours: range.hours, traffic: tf.traffic, q, outcome, channel, sort, dir, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Links keep every current parameter and change only what they need to.
  const href = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v) next.set(k, v);
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    return `/conversations${s ? `?${s}` : ''}`;
  };
  const sortHeader = (col: ConversationSort, label: string) => {
    const active = sort === col;
    const nextDir = active && dir === 'desc' ? 'asc' : 'desc';
    const Icon = active ? (dir === 'desc' ? ArrowDown : ArrowUp) : null;
    return (
      <Link href={href({ sort: col === 'started' && nextDir === 'desc' ? null : col, dir: nextDir === 'desc' ? null : 'asc', page: null })} className="inline-flex items-center gap-1 hover:text-foreground" aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : undefined}>
        {label}
        {Icon && <Icon className="size-3" />}
      </Link>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Conversations" description={`Every conversation in the ${range.label.toLowerCase()} (${tf.label.toLowerCase()}), with its tool calls and timings. Evaluation runs are kept out.`} />
      <ConversationControls total={total} />
      <Card className="gap-0 overflow-hidden py-0 shadow-none">
        {rows.length ? (
          <ConversationsTable rows={rows} qs={filterQuery(sp)} sortHeader={sortHeader} />
        ) : (
          <div className="p-4">
            <EmptyState icon={<MessagesSquare />} title={q || outcome || channel ? 'No conversations match these filters' : 'No conversations in this period'}>
              {q || outcome || channel ? 'Try a wider time range or clear a filter.' : 'Demo texts and the daily synthetic check appear here.'}
            </EmptyState>
          </div>
        )}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-muted-foreground">
            <span className="tabular">
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex gap-1">
              <Button asChild={page > 1} variant="outline" size="icon" className="size-7" aria-label="Previous page" disabled={page <= 1}>
                {page > 1 ? (
                  <Link href={href({ page: page - 1 === 1 ? null : String(page - 1) })}>
                    <ChevronLeft />
                  </Link>
                ) : (
                  <ChevronLeft />
                )}
              </Button>
              <Button asChild={page < pages} variant="outline" size="icon" className="size-7" aria-label="Next page" disabled={page >= pages}>
                {page < pages ? (
                  <Link href={href({ page: String(page + 1) })}>
                    <ChevronRight />
                  </Link>
                ) : (
                  <ChevronRight />
                )}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
