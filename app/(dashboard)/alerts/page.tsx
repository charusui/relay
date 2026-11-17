import { BellOff, BellRing, CheckCircle2, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LocalTime } from '@/components/relay/client';
import { SyntheticRuns, type Run } from '@/components/relay/synthetic-runs';
import { EmptyState, PageHeader } from '@/components/relay/ui';
import { COOLDOWN_HOURS, RULES } from '../../../src/monitor/alerts.ts';
import { recentAlerts, recentSyntheticRuns } from '../../../src/monitor/metrics.ts';
import { SYNTHETIC_CASE_IDS } from '../../../src/monitor/synthetic.ts';
import { relay } from '../../lib/relay.ts';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'iad1';
export const metadata = { title: 'Alerts' };

const RULE_TITLE: Record<string, string> = {
  error_rate: 'Failed messages',
  handoff_rate: 'Hand-off rate',
  latency_p95: 'Slow replies',
  token_spike: 'Token spike',
  withheld_reply: 'Withheld reply',
  synthetic_check: 'Daily check failed',
};

const formatValue = (rule: string, v: number | null, threshold: number | null) => {
  if (v === null) return '–';
  if (rule === 'synthetic_check' && threshold !== null) return `${Math.round(v)}/${Math.round(threshold)}`;
  if (rule === 'error_rate' || rule === 'handoff_rate') return `${Math.round(v * 100)}%`;
  if (rule === 'latency_p95') return `${(v / 1000).toFixed(1)} s`;
  if (rule === 'token_spike') return `${v.toFixed(1)}×`;
  return String(Math.round(v));
};

export default async function AlertsPage() {
  const { db } = await relay();
  const [alerts, runs] = await Promise.all([recentAlerts(db, 50), recentSyntheticRuns(db, 30)]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Alerts"
        description={`Rules checked after every live message and after the daily check. Each rule fires at most once every ${COOLDOWN_HOURS} hours and posts to Slack.`}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="gap-0 overflow-hidden py-0 shadow-none">
          <CardHeader className="border-b py-4">
            <CardTitle>Alert history</CardTitle>
            <CardDescription>Most recent first</CardDescription>
          </CardHeader>
          {alerts.length ? (
            <div className="overflow-x-auto">
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[150px] pl-4">When</TableHead>
                    <TableHead className="w-[150px]">Rule</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead className="w-[90px] text-right">Value</TableHead>
                    <TableHead className="w-[110px] pr-4">Slack</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {alerts.map((a, i) => (
                    <TableRow key={i}>
                      <TableCell className="pl-4 text-muted-foreground">
                        <LocalTime iso={a.at} />
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="gap-1 text-foreground">
                          <BellRing className="text-chart-2" /> {RULE_TITLE[a.rule] ?? a.rule}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-0">
                        <p className="line-clamp-2 whitespace-normal">{a.message}</p>
                      </TableCell>
                      <TableCell className="tabular text-right">{formatValue(a.rule, a.value, a.threshold)}</TableCell>
                      <TableCell className="pr-4 text-xs text-muted-foreground">
                        {a.posted ? (
                          <span className="inline-flex items-center gap-1">
                            <Send className="size-3" /> Sent
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <BellOff className="size-3" /> Not sent
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="p-4">
              <EmptyState icon={<CheckCircle2 />} title="No alerts have fired" />
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle>Rules</CardTitle>
              <CardDescription>Starting thresholds chosen before any traffic existed, not tuned values</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-3 text-sm">
                {RULES.map((r) => (
                  <li key={r.id}>
                    <p className="font-medium">{RULE_TITLE[r.id] ?? r.id}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{r.describe}</p>
                  </li>
                ))}
                <li>
                  <p className="font-medium">{RULE_TITLE.synthetic_check}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">Any of the {SYNTHETIC_CASE_IDS.length} scripted cases in the daily check fails</p>
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="gap-0 overflow-hidden py-0 shadow-none">
        <CardHeader className="border-b py-4">
          <CardTitle>Daily synthetic check</CardTitle>
          <CardDescription>
            {SYNTHETIC_CASE_IDS.length} scripted conversations from the dev split (tracking, a return, a policy answer, an injection attempt, a hand-off), sent through the live agent at 09:00 UTC and graded by the eval grader. Expand a run to see each case.
          </CardDescription>
        </CardHeader>
        {runs.length ? (
          <SyntheticRuns runs={runs as Run[]} />
        ) : (
          <div className="p-4">
            <EmptyState title="No check has run yet" />
          </div>
        )}
      </Card>
    </div>
  );
}
