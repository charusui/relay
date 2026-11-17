'use client';

import { ArrowRight, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { RANGES, TRAFFIC } from '@/lib/filters';
import { ALL_NAV, navFor } from '@/lib/nav';
import { ThemeToggle } from './theme';

/** Pages where the time range and traffic filters change what is shown. */
const FILTERED = ['/', '/conversations', '/handoffs'];

export function SiteHeader() {
  const pathname = usePathname();
  const current = navFor(pathname);
  const isDetail = pathname.startsWith('/conversations/');
  const showFilters = FILTERED.includes(pathname);

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 md:px-4">
      <SidebarTrigger className="-ml-1 size-8" />
      <Separator orientation="vertical" className="mr-1 hidden data-[orientation=vertical]:h-4 sm:block" />
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap">
          {isDetail ? (
            <>
              <BreadcrumbItem className="hidden sm:inline-flex">
                <Link href="/conversations" className="transition-colors hover:text-foreground">
                  Conversations
                </Link>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden sm:inline-flex" />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate font-mono text-xs">{pathname.split('/').pop()}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : (
            <BreadcrumbItem>
              <BreadcrumbPage>{current?.title ?? 'Relay'}</BreadcrumbPage>
            </BreadcrumbItem>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-1.5">
        {showFilters && <Filters />}
        <CommandMenu />
        <ThemeToggle />
      </div>
    </header>
  );
}

function Filters() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const set = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(sp.toString());
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    next.delete('page');
    start(() => router.replace(`${pathname}${next.toString() ? `?${next}` : ''}`, { scroll: false }));
  };
  return (
    <div className="flex items-center gap-1.5" data-pending={pending ? '' : undefined}>
      <Select value={sp.get('traffic') ?? 'all'} onValueChange={(v) => set('traffic', v, 'all')}>
        <SelectTrigger size="sm" className="hidden w-[148px] md:flex" aria-label="Traffic">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {TRAFFIC.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={sp.get('range') ?? '7d'} onValueChange={(v) => set('range', v, '7d')}>
        <SelectTrigger size="sm" className="w-[84px] sm:w-[136px]" aria-label="Time range">
          <SelectValue>{RANGES.find((r) => r.id === (sp.get('range') ?? '7d'))?.short}</SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          {RANGES.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [mac, setMac] = useState(false);
  const router = useRouter();
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const go = (href: string) => {
    setOpen(false);
    setQuery('');
    router.push(href);
  };
  return (
    <>
      <Button variant="outline" size="sm" className="h-8 gap-2 px-2.5 text-muted-foreground sm:w-48 sm:justify-start" onClick={() => setOpen(true)} aria-label="Search">
        <Search className="size-4" />
        <span className="hidden sm:inline">Search…</span>
        <kbd className="ml-auto hidden rounded border bg-muted px-1.5 font-mono text-[10px] font-medium sm:inline">{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search Relay" description="Jump to a page or search conversations">
        <Command>
        <CommandInput placeholder="Search conversations or jump to a page…" value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>No pages match.</CommandEmpty>
          {query.trim() && (
            <>
              <CommandGroup heading="Conversations">
                <CommandItem value={`search ${query}`} onSelect={() => go(`/conversations?q=${encodeURIComponent(query.trim())}`)}>
                  <Search />
                  Search conversations for “{query.trim()}”
                </CommandItem>
                {/^conv_[a-z0-9-]+$/i.test(query.trim()) && (
                  <CommandItem value={`open ${query}`} onSelect={() => go(`/conversations/${query.trim()}`)}>
                    <ArrowRight />
                    Open {query.trim()}
                  </CommandItem>
                )}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}
          <CommandGroup heading="Pages">
            {ALL_NAV.map((item) => (
              <CommandItem key={item.href} value={`${item.title} ${item.description}`} onSelect={() => go(item.href)}>
                <item.icon />
                <span>{item.title}</span>
                <span className="ml-2 truncate text-xs text-muted-foreground">{item.description}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
