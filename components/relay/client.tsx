'use client';

import { Info, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';

/* ------------------------------------------------------------ local time */

/** Server renders UTC; the browser swaps in the viewer's local time (or a relative time). */
export function LocalTime({ iso, mode = 'datetime' }: { iso: string; mode?: 'datetime' | 'relative' | 'time' }) {
  const [text, setText] = useState(() => `${iso.slice(0, 16).replace('T', ' ')} UTC`);
  useEffect(() => {
    const d = new Date(iso);
    if (mode === 'relative') {
      const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
      setText(s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} d ago`);
    } else if (mode === 'time') {
      setText(d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    } else {
      setText(d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
    }
  }, [iso, mode]);
  return (
    <time dateTime={iso} title={new Date(iso).toUTCString()} suppressHydrationWarning>
      {text}
    </time>
  );
}

/* ------------------------------------------------------------ info banner */

const BANNER_KEY = 'relay-banner-dismissed-v1';

export function InfoBanner() {
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(BANNER_KEY) === '1');
    } catch {
      setHidden(false);
    }
  }, []);
  if (hidden) return null;
  return (
    <div className="flex items-start gap-2.5 border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground md:px-6">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <p className="flex-1">
        <span className="font-medium text-foreground">Demo environment.</span> Pinecrest Supply is a fictional store. Traffic here is demo texts and a daily synthetic check, not real customers. Accuracy is measured offline on a frozen test set (see Evals).
      </p>
      <Button
        variant="ghost"
        size="icon"
        className="-my-1 size-6"
        aria-label="Dismiss"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(BANNER_KEY, '1');
          } catch {
            // storage blocked: hidden for this visit only
          }
        }}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------ charts */

const shortDay = (day: string) => {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
};

export type DayVolume = { day: string; answered: number; handedOff: number };

const volumeConfig = {
  answered: { label: 'Answered by Relay', color: 'var(--chart-1)' },
  handedOff: { label: 'Handed to a person', color: 'var(--chart-2)' },
} satisfies ChartConfig;

export function VolumeChart({ data }: { data: DayVolume[] }) {
  return (
    <ChartContainer config={volumeConfig} className="aspect-auto h-[220px] w-full">
      <BarChart data={data} margin={{ left: -18, right: 4, top: 8 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={shortDay} minTickGap={16} className="tabular" />
        <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={44} className="tabular" />
        <ChartTooltip cursor={{ fill: 'var(--muted)', opacity: 0.6 }} content={<ChartTooltipContent labelFormatter={(d) => `${d} (UTC)`} />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="answered" stackId="v" fill="var(--color-answered)" radius={[0, 0, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        <Bar dataKey="handedOff" stackId="v" fill="var(--color-handedOff)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
}

export function TrendChart({ data, label, unit }: { data: { day: string; value: number | null }[]; label: string; unit: 'seconds' | 'tokens' }) {
  const config = { value: { label, color: 'var(--chart-1)' } } satisfies ChartConfig;
  const format = (v: number) =>
    unit === 'seconds' ? (v === 0 ? '0 s' : v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(v < 10 ? 1 : 0)} s`) : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
  return (
    <ChartContainer config={config} className="aspect-auto h-[180px] w-full">
      <LineChart data={data} margin={{ left: -6, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={shortDay} minTickGap={16} />
        <YAxis tickLine={false} axisLine={false} width={46} tickFormatter={format} domain={[0, 'auto']} tickCount={4} allowDecimals={unit === 'seconds'} />
        <ChartTooltip
          cursor={{ stroke: 'var(--border)' }}
          content={<ChartTooltipContent labelFormatter={(d) => `${d} (UTC)`} formatter={(v) => (v === null || v === undefined ? 'no replies' : format(Number(v)))} />}
        />
        <Line dataKey="value" type="monotone" stroke="var(--color-value)" strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: 'var(--color-value)' }} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </ChartContainer>
  );
}
