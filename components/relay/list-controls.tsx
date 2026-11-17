'use client';

import { Search, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

function useParamSetter() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const set = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in updates)) next.delete('page');
    start(() => router.replace(`${pathname}${next.toString() ? `?${next}` : ''}`, { scroll: false }));
  };
  return { sp, set, pending };
}

export function ConversationControls({ total }: { total: number }) {
  const { sp, set, pending } = useParamSetter();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => setQ(sp.get('q') ?? ''), [sp]);
  const onSearch = (value: string) => {
    setQ(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => set({ q: value.trim() || null }), 300);
  };
  return (
    <div className={cn('flex flex-col gap-3 md:flex-row md:items-center md:justify-between', pending && 'opacity-80')}>
      <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => onSearch(e.target.value)} placeholder="Search messages or conversation ID" className="h-8 pr-8 pl-8" aria-label="Search conversations" />
          {q && (
            <Button variant="ghost" size="icon" className="absolute top-1/2 right-1 size-6 -translate-y-1/2" aria-label="Clear search" onClick={() => onSearch('')}>
              <X className="size-3.5" />
            </Button>
          )}
        </div>
        <Tabs value={sp.get('outcome') ?? 'all'} onValueChange={(v) => set({ outcome: v === 'all' ? null : v })}>
          <TabsList className="h-8">
            <TabsTrigger value="all" className="text-xs">
              All
            </TabsTrigger>
            <TabsTrigger value="answered" className="text-xs">
              Answered
            </TabsTrigger>
            <TabsTrigger value="handed_off" className="text-xs">
              Handed off
            </TabsTrigger>
            <TabsTrigger value="failed" className="text-xs">
              Failed
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Select value={sp.get('channel') ?? 'all'} onValueChange={(v) => set({ channel: v === 'all' ? null : v })}>
          <SelectTrigger size="sm" className="w-[128px]" aria-label="Channel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            <SelectItem value="sms">SMS</SelectItem>
            <SelectItem value="email">Email</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="tabular text-xs text-muted-foreground" aria-live="polite">
        {total.toLocaleString('en-US')} conversation{total === 1 ? '' : 's'}
      </p>
    </div>
  );
}
