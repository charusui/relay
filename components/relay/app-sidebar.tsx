'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { NAV } from '@/lib/nav';
import { cn } from '@/lib/utils';

export type SystemStatus = { level: 'ok' | 'warn' | 'down'; label: string; detail: string };

export function AppSidebar({ openHandoffs, status }: { openHandoffs: number; status: SystemStatus }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  // Carry the time range and traffic filter across pages.
  const keep = new URLSearchParams();
  for (const k of ['range', 'traffic']) {
    const v = sp.get(k);
    if (v) keep.set(k, v);
  }
  const qs = keep.toString() ? `?${keep}` : '';
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href={`/${qs}`}>
                <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-foreground text-background">
                  <RelayMark className="size-4" />
                </span>
                <span className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">Relay</span>
                  <span className="truncate text-xs text-muted-foreground">Pinecrest Supply · demo</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {NAV.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={item.title}>
                      <Link href={`${item.href}${qs}`}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.href === '/handoffs' && openHandoffs > 0 && <SidebarMenuBadge className="tabular">{openHandoffs}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip={`${status.label}: ${status.detail}`}>
              <Link href={`/alerts${qs}`}>
                <StatusDot level={status.level} className="ml-1.5" />
                <span className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-medium">{status.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{status.detail}</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export function StatusDot({ level, className }: { level: SystemStatus['level']; className?: string }) {
  const color = level === 'ok' ? 'bg-success' : level === 'warn' ? 'bg-warning' : 'bg-destructive';
  return (
    <span className={cn('inline-flex size-2 shrink-0 rounded-full ring-2 ring-current/15', color, className)} aria-hidden="true" />
  );
}

function RelayMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M2.5 4.5h7a2.5 2.5 0 0 1 0 5h-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m7.5 7.5-2 2 2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="13" cy="12" r="1.25" fill="currentColor" />
    </svg>
  );
}
