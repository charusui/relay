import { ArrowRight, CheckCircle2, FileText, FlaskConical } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fmt, PageHeader, SectionTitle } from '@/components/relay/ui';
import { cn } from '@/lib/utils';
import results from '../../../data/eval-results.json';

export const metadata = { title: 'Evals' };

type Version = (typeof results.versions)[number];

const docHref = (doc: string) => `/evals/docs/${doc.replace(/^docs\//, '').replace(/\.md$/, '')}`;

const METRICS: { key: keyof Version['metrics'] | 'hand'; label: string; short: string; info: string; better: 'up' | 'down'; render: (v: Version) => string }[] = [
  { key: 'resolution', label: 'Resolution', short: 'Resolution', info: 'Conversation ended in the expected outcome with the required facts.', better: 'up', render: (v) => fmt.pctOf(v.metrics.resolution) },
  { key: 'toolUse', label: 'Correct tool use', short: 'Tool use', info: 'Required tools with the right arguments, in order, and nothing forbidden attempted.', better: 'up', render: (v) => fmt.pctOf(v.metrics.toolUse) },
  { key: 'unnecessaryEscalations', label: 'Unnecessary hand-offs', short: 'Unneeded hand-offs', info: 'Handed to a person when it should have answered (of the 36 cases that should not escalate).', better: 'down', render: (v) => fmt.pctOf(v.metrics.unnecessaryEscalations) },
  { key: 'missedEscalations', label: 'Missed hand-offs', short: 'Missed hand-offs', info: 'Did not hand off when it should have (of the 7 cases that should escalate).', better: 'down', render: (v) => fmt.pctOf(v.metrics.missedEscalations) },
  { key: 'hand', label: 'Groundedness (hand)', short: 'Grounded (hand)', info: 'Every factual claim backed by a tool result or policy, checked by reading each conversation. The headline groundedness number.', better: 'up', render: (v) => fmt.pctOf(v.groundednessHand.value) },
  { key: 'groundednessJudge', label: 'Groundedness (judge)', short: 'Grounded (judge)', info: "A second model's verdict on the same question. A first pass only: it has missed problems the hand check found.", better: 'up', render: (v) => fmt.pctOf(v.metrics.groundednessJudge) },
  { key: 'tokensPerConversation', label: 'Tokens / conv.', short: 'Tokens', info: 'Input plus output tokens across all model calls in a conversation.', better: 'down', render: (v) => fmt.int(v.metrics.tokensPerConversation) },
];

export default function EvalsPage() {
  const current = results.versions.find((v) => v.id === results.currentVersion)!;
  const caseShare = (100 / results.testSet.cases).toFixed(1);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Evals"
        description={
          <>
            Live traffic can&apos;t tell you whether an answer was right; a frozen test set can. Every prompt or model change is re-run on the same {results.testSet.cases} scripted conversations across {results.testSet.categories.length} categories, compared with an A/B report, and read by hand before it ships.
          </>
        }
      />

      <section className="flex flex-col gap-3">
        <SectionTitle
          description={
            <>
              Version <span className="font-mono">{current.variant}</span>, test run <span className="font-mono">{current.run}</span>
            </>
          }
          action={
            <Link href={docHref(current.source)} className="inline-flex items-center gap-1 text-xs font-medium hover:underline">
              Full report <ArrowRight className="size-3.5" />
            </Link>
          }
        >
          Current version on the frozen test set
        </SectionTitle>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          {METRICS.map((m) => (
            <Card key={m.key} className="gap-1 py-3 shadow-none">
              <CardContent className="px-4">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="line-clamp-2 min-h-8 cursor-help text-xs leading-4 font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/40 underline-offset-4">{m.label}</p>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64">{m.info}</TooltipContent>
                </Tooltip>
                <p className="tabular mt-1.5 text-xl font-semibold tracking-tight">{m.render(current)}</p>
                <p className="tabular text-xs text-muted-foreground">
                  {m.key === 'tokensPerConversation' ? 'per conversation' : m.key === 'hand' ? fmt.frac(current.groundednessHand.value) : fmt.frac(current.metrics[m.key as 'resolution'])}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          One case is {caseShare} points, and a difference of two cases or fewer is within run-to-run noise, so decisions rest on repeated runs of the cases that changed. Scripted conversations against a fictional store, not production traffic.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle description="Each row is one shipped version, measured on the same test set">Version history</SectionTitle>
        <Card className="gap-0 overflow-hidden py-0 shadow-none">
          <div className="overflow-x-auto">
            <Table className="min-w-[780px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Version</TableHead>
                  {METRICS.map((m) => (
                    <TableHead key={m.key} className="text-right whitespace-normal">
                      {m.short}
                    </TableHead>
                  ))}
                  <TableHead className="pr-4 text-right">p95</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...results.versions].reverse().map((v) => (
                  <TableRow key={v.id} className={cn(v.id === current.id && 'bg-muted/40')}>
                    <TableCell className="pl-4">
                      <Link href={docHref(v.source)} className="font-medium hover:underline">
                        {v.label}
                      </Link>
                      {v.id === current.id && (
                        <Badge variant="outline" className="ml-2 gap-1 align-middle text-[10px]">
                          <CheckCircle2 className="text-success" /> live
                        </Badge>
                      )}
                      <p className="font-mono text-xs text-muted-foreground">{v.variant}</p>
                    </TableCell>
                    {METRICS.map((m) => (
                      <TableCell key={m.key} className="tabular text-right">
                        {m.render(v)}
                      </TableCell>
                    ))}
                    <TableCell className="tabular pr-4 text-right text-muted-foreground">{v.metrics.latencyP95s.toFixed(1)} s</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
        <p className="text-xs text-muted-foreground">Latency is on a free tier and swings with quota pressure (release v1&apos;s 19 s p95 was a run made while the daily limit was nearly used up), so it is shown but not used to decide.</p>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle description="Each one started from a real failure and changed one thing">A/B experiments</SectionTitle>
        <div className="grid gap-3 lg:grid-cols-3">
          {[...results.experiments].reverse().map((e) => (
            <Card key={e.id} className="shadow-none">
              <CardHeader>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FlaskConical className="size-3.5" />
                  <span className="font-mono uppercase">{e.id}</span>
                </div>
                <CardTitle className="leading-snug">{e.title}</CardTitle>
                <CardDescription className="font-mono text-xs">
                  {e.variants[0]} → {e.variants[1]}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <Field label="Why">{e.hypothesis}</Field>
                <Field label="Result">{e.result}</Field>
                <Field label="Decision">{e.decision}</Field>
              </CardContent>
              <CardFooter className="mt-auto">
                <Link href={docHref(e.doc)} className="inline-flex items-center gap-1 text-xs font-medium hover:underline">
                  Read the write-up <ArrowRight className="size-3.5" />
                </Link>
              </CardFooter>
            </Card>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle description="Real failures found by the evals or the live checks: symptom, root cause, the change, and what it moved">Failure write-ups</SectionTitle>
        <Card className="gap-0 py-0 shadow-none">
          <ul className="divide-y">
            {results.failures.map((f) => (
              <li key={f.id}>
                <Link href={docHref(f.doc)} className="flex flex-col gap-1 px-4 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:gap-4">
                  <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                    <FileText className="size-3.5" /> {f.id}
                  </span>
                  <span className="flex-1 text-sm first-letter:uppercase">{f.title}</span>
                  <span className="text-xs text-muted-foreground sm:max-w-sm sm:text-right">{f.fix}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-0.5 leading-relaxed">{children}</p>
    </div>
  );
}
