import { cookies } from 'next/headers';
import { Suspense, type ReactNode } from 'react';
import { AppSidebar, type SystemStatus } from '@/components/relay/app-sidebar';
import { InfoBanner } from '@/components/relay/client';
import { SiteHeader } from '@/components/relay/site-header';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { openHandoffs, recentAlerts, recentSyntheticRuns } from '../../src/monitor/metrics.ts';
import { relay } from '../lib/relay.ts';

export const dynamic = 'force-dynamic';
// Run next to the Neon database (AWS us-east-1).
export const preferredRegion = 'iad1';

function ago(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

async function loadShell(): Promise<{ handoffs: number; status: SystemStatus }> {
  try {
    const { db } = await relay();
    const [queue, runs, alerts] = await Promise.all([openHandoffs(db), recentSyntheticRuns(db, 1), recentAlerts(db, 20)]);
    const last = runs[0];
    const recent = alerts.filter((a) => Date.now() - new Date(a.at).getTime() < 24 * 3_600_000).length;
    let status: SystemStatus;
    if (!last) status = { level: 'warn', label: 'No daily check yet', detail: 'The synthetic check has not run' };
    else if (last.passed < last.total) status = { level: 'warn', label: 'Daily check failing', detail: `${last.passed}/${last.total} passed · ${ago(last.at)}` };
    else if (recent > 0) status = { level: 'warn', label: 'Needs attention', detail: `${recent} alert${recent > 1 ? 's' : ''} in 24 h` };
    else status = { level: 'ok', label: 'All systems normal', detail: `Daily check ${last.passed}/${last.total} · ${ago(last.at)}` };
    return { handoffs: queue.length, status };
  } catch {
    return { handoffs: 0, status: { level: 'down', label: 'Database unreachable', detail: 'See System for details' } };
  }
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const [shell, jar] = await Promise.all([loadShell(), cookies()]);
  const open = jar.get('sidebar_state')?.value !== 'false';
  return (
    <SidebarProvider defaultOpen={open}>
      <Suspense>
        <AppSidebar openHandoffs={shell.handoffs} status={shell.status} />
      </Suspense>
      <SidebarInset className="min-w-0">
        <Suspense fallback={<div className="h-14 border-b" />}>
          <SiteHeader />
        </Suspense>
        <InfoBanner />
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 md:px-6 lg:py-8">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
