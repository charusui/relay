'use client';

import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { LocalTime } from './client';

type CaseResult = { caseId: string; title: string; pass: boolean; reasons: string[]; error?: string };
export type Run = { id: number; passed: number; total: number; errors: number; at: string; details: CaseResult[] };

/** Synthetic check history; each run expands to its scripted cases. */
export function SyntheticRuns({ runs }: { runs: Run[] }) {
  return (
    <ul className="divide-y">
      {runs.map((r, i) => (
        <RunRow key={r.id} run={r} defaultOpen={i === 0 && r.passed < r.total} />
      ))}
    </ul>
  );
}

function RunRow({ run, defaultOpen }: { run: Run; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const ok = run.passed === run.total;
  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className={cn('size-2 shrink-0 rounded-full', ok ? 'bg-success' : 'bg-destructive')} aria-hidden="true" />
          <span className="tabular font-medium">
            {run.passed}/{run.total} passed
          </span>
          <span className="text-xs text-muted-foreground">{ok ? 'Pass' : run.errors ? `${run.errors} errored` : 'Fail'}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            <LocalTime iso={run.at} />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="flex flex-col gap-1 px-4 pb-3 pl-11">
            {run.details.map((c) => (
              <li key={c.caseId} className="flex items-start gap-2 text-xs">
                <span className={cn('mt-1 size-1.5 shrink-0 rounded-full', c.pass ? 'bg-success' : 'bg-destructive')} aria-hidden="true" />
                <span className="w-20 shrink-0 font-mono">{c.caseId}</span>
                <span className="min-w-0 text-muted-foreground">
                  {c.title}
                  {!c.pass && <span className="block text-destructive">{c.error ? c.error : c.reasons.join('; ') || 'failed'}</span>}
                </span>
                <span className="ml-auto shrink-0">{c.pass ? 'pass' : 'fail'}</span>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
