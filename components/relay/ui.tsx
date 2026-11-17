// Server-safe building blocks shared by the dashboard pages.

import { AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, CircleSlash, Hand, Minus, ShieldAlert, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------ page header */

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionTitle({ children, description, action }: { children: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold">{children}</h2>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/* ------------------------------------------------------------ empty state */

export function EmptyState({ icon, title, children, className }: { icon?: ReactNode; title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center', className)}>
      {icon && <div className="text-muted-foreground [&_svg]:size-5">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="max-w-sm text-xs text-muted-foreground">{children}</p>}
    </div>
  );
}

/* ------------------------------------------------------------ badges */

const REASON: Record<string, string> = {
  angry_customer: 'Upset or asked for a person',
  refund_over_threshold: 'Refund over $150',
  low_confidence: 'Could not answer confidently',
};

export function reasonLabel(reason: string) {
  return REASON[reason] ?? reason;
}

export function OutcomeBadge({ outcome, reason }: { outcome: 'answered' | 'handed_off' | 'failed'; reason?: string | null }) {
  if (outcome === 'failed')
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle /> Failed
      </Badge>
    );
  if (outcome === 'handed_off')
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="gap-1 border-chart-2/40 text-foreground">
            <Hand className="text-chart-2" /> Handed off
          </Badge>
        </TooltipTrigger>
        {reason && <TooltipContent>{reasonLabel(reason)}</TooltipContent>}
      </Tooltip>
    );
  return (
    <Badge variant="outline" className="gap-1 text-foreground">
      <CheckCircle2 className="text-success" /> Answered
    </Badge>
  );
}

export function TrafficBadge({ traffic }: { traffic: string }) {
  return (
    <Badge variant="secondary" className="font-normal capitalize text-muted-foreground">
      {traffic}
    </Badge>
  );
}

export function ReasonBadge({ reason, source }: { reason: string; source?: 'agent' | 'code' }) {
  const Icon = reason === 'refund_over_threshold' ? ShieldAlert : reason === 'low_confidence' ? CircleSlash : AlertTriangle;
  return (
    <Badge variant="outline" className="gap-1 text-foreground">
      <Icon className="text-chart-2" />
      {reasonLabel(reason)}
      {source && <span className="text-muted-foreground">· {source === 'agent' ? 'agent' : 'safety net'}</span>}
    </Badge>
  );
}

export function PassBadge({ pass, children }: { pass: boolean; children?: ReactNode }) {
  return pass ? (
    <Badge variant="outline" className="gap-1 text-foreground">
      <CheckCircle2 className="text-success" /> {children ?? 'Pass'}
    </Badge>
  ) : (
    <Badge variant="destructive" className="gap-1">
      <XCircle /> {children ?? 'Fail'}
    </Badge>
  );
}

/* ------------------------------------------------------------ KPI tile */

export type Delta = { value: number; better: 'up' | 'down' | 'none'; format: (v: number) => string } | null;

export function Kpi({ label, value, unit, hint, delta, spark, info }: { label: string; value: string; unit?: string; hint?: ReactNode; delta?: Delta; spark?: (number | null)[]; info?: string }) {
  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardContent className="flex h-full flex-col gap-2 px-4 py-3.5">
        {info ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="w-fit max-w-full cursor-help truncate text-xs font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/40 underline-offset-4">{label}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{info}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
        )}
        <div className="flex items-end justify-between gap-3">
          <div className="tabular text-2xl font-semibold tracking-tight">
            {value}
            {unit && <span className="ml-0.5 text-sm font-medium text-muted-foreground">{unit}</span>}
          </div>
          {spark && spark.some((v) => v !== null && v > 0) && <Sparkline values={spark} />}
        </div>
        <div className="mt-auto flex items-center justify-between gap-2">
          {hint ? <span className="truncate text-xs text-muted-foreground">{hint}</span> : <span />}
          {delta !== undefined && <DeltaPill delta={delta} />}
        </div>
      </CardContent>
    </Card>
  );
}

function DeltaPill({ delta }: { delta: Delta }) {
  if (!delta || !Number.isFinite(delta.value))
    return (
      <span className="shrink-0 text-[11px] text-muted-foreground" title="Nothing to compare with in the previous period">
        new
      </span>
    );
  if (Math.abs(delta.value) < 1e-9)
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
        <Minus className="size-3" /> same
      </span>
    );
  const up = delta.value > 0;
  const good = delta.better === 'none' ? null : (delta.better === 'up') === up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn('tabular inline-flex items-center gap-0.5 text-[11px] font-medium', good === null ? 'text-muted-foreground' : good ? 'text-success' : 'text-destructive')}>
      <Icon className="size-3" />
      {delta.format(Math.abs(delta.value))}
    </span>
  );
}

/** A tiny inline trend line; days with no data leave a gap. Decorative: the number beside it is the data. */
export function Sparkline({ values, className }: { values: (number | null)[]; className?: string }) {
  const w = 72;
  const h = 24;
  const nums = values.filter((v): v is number => v !== null);
  const max = Math.max(...nums, 1e-9);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  let d = '';
  values.forEach((v, i) => {
    if (v === null) return;
    const x = i * step;
    const y = h - 2 - (v / max) * (h - 4);
    d += `${d && values[i - 1] !== null ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={cn('shrink-0 text-chart-1', className)} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ------------------------------------------------------------ small formatters */

export const fmt = {
  int: (v: number | null | undefined) => (v === null || v === undefined ? '–' : Math.round(v).toLocaleString('en-US')),
  pct: (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(digits).replace(/\.0$/, '')}`),
  secs: (ms: number | null | undefined) => (ms === null || ms === undefined ? '–' : (ms / 1000).toFixed(ms < 10_000 ? 1 : 0)),
  frac: ([a, b]: number[]) => `${a}/${b}`,
  pctOf: ([a, b]: number[]) => (b ? `${((a / b) * 100).toFixed(1).replace(/\.0$/, '')}%` : '–'),
  duration: (ms: number) => {
    const m = Math.floor(ms / 60_000);
    if (m < 1) return 'under a minute';
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h} h ${m % 60} min`;
    return `${Math.floor(h / 24)} days`;
  },
};
