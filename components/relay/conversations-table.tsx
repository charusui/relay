import { CornerDownRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ConversationRowView } from '../../src/monitor/metrics.ts';
import { LocalTime } from './client';
import { fmt, OutcomeBadge, TrafficBadge } from './ui';

/** Conversation rows; the whole row links to the thread. `sortHeader` lets a page make headers sortable. */
export function ConversationsTable({ rows, qs = '', sortHeader, compact = false }: { rows: ConversationRowView[]; qs?: string; sortHeader?: (col: 'started' | 'replies' | 'tokens' | 'latency', label: string) => ReactNode; compact?: boolean }) {
  const head = (col: 'started' | 'replies' | 'tokens' | 'latency', label: string) => (sortHeader ? sortHeader(col, label) : label);
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[132px] pl-4">{head('started', 'Started')}</TableHead>
            <TableHead className="w-[170px]">Customer</TableHead>
            <TableHead>{compact ? 'First message' : 'Messages'}</TableHead>
            <TableHead className="w-[140px]">Outcome</TableHead>
            <TableHead className="w-[76px] text-right">{head('replies', 'Replies')}</TableHead>
            <TableHead className="w-[84px] text-right">{head('tokens', 'Tokens')}</TableHead>
            <TableHead className="w-[96px] pr-4 text-right">{head('latency', 'Avg reply')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => (
            <TableRow key={c.id} className="relative cursor-pointer">
              <TableCell className="pl-4 text-muted-foreground">
                <Link href={`/conversations/${c.id}${qs}`} className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset" aria-label={`Open conversation ${c.id}`}>
                  <LocalTime iso={c.createdAt} />
                </Link>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs">{c.channel.toUpperCase()}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{c.contact}</span>
                </div>
                {!compact && (
                  <div className="mt-1">
                    <TrafficBadge traffic={c.traffic} />
                  </div>
                )}
              </TableCell>
              <TableCell className="max-w-0">
                <p className="truncate">{c.firstMessage ?? '–'}</p>
                {!compact && c.lastMessage && c.lastMessage !== c.firstMessage && (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <CornerDownRight className="size-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{c.lastMessage}</span>
                  </p>
                )}
              </TableCell>
              <TableCell>
                <OutcomeBadge outcome={c.outcome} reason={c.handoffReason} />
              </TableCell>
              <TableCell className="tabular text-right">{c.turns}</TableCell>
              <TableCell className="tabular text-right text-muted-foreground">{fmt.int(c.tokens)}</TableCell>
              <TableCell className="tabular pr-4 text-right text-muted-foreground">{c.avgLatencyMs === null ? '–' : `${fmt.secs(c.avgLatencyMs)} s`}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
