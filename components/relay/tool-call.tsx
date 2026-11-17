'use client';

import { ChevronRight, Wrench, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/** One tool call in a turn's timeline: collapsed to name + duration, expandable to its input and output. */
export function ToolCall({ name, input, output, isError, durationMs }: { name: string; input: unknown; output: unknown; isError: boolean; durationMs: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border bg-muted/30">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        {isError ? <XCircle className="size-3.5 shrink-0 text-destructive" /> : <Wrench className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="font-mono font-medium">{name}</span>
        <span className="truncate font-mono text-muted-foreground">{summarize(input)}</span>
        <span className="tabular ml-auto shrink-0 text-muted-foreground">{durationMs < 1 ? '<1' : Math.round(durationMs)} ms</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-2 border-t p-2.5 md:grid-cols-2">
          <Json label="Input" value={input} />
          <Json label={isError ? 'Error' : 'Result'} value={output} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function summarize(input: unknown) {
  if (!input || typeof input !== 'object') return '';
  const s = Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[11px] font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-72 overflow-auto rounded bg-background p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
