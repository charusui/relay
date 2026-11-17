import { CheckCircle2, CircleDashed, Database, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PageHeader } from '@/components/relay/ui';
import { MAX_RATE_LIMIT_WAIT_MS } from '../../../src/agent/openaiCompat.ts';
import { buildSystemPrompt, DEFAULT_VARIANT, getVariant, toolsFor } from '../../../src/agent/variants.ts';
import { RETRIEVAL_VERSION } from '../../../src/policy/retrieval.ts';
import { relay } from '../../lib/relay.ts';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'iad1';
export const metadata = { title: 'System' };

// Names only: the page shows whether each setting exists, never its value.
const SETTINGS: { name: string; purpose: string }[] = [
  { name: 'DATABASE_URL', purpose: 'Hosted Postgres (Neon)' },
  { name: 'GEMINI_API_KEY', purpose: 'Agent model (separate project from the evals)' },
  { name: 'CRON_SECRET', purpose: 'Protects the daily check route' },
  { name: 'TWILIO_AUTH_TOKEN', purpose: 'Signs and verifies SMS webhook requests' },
  { name: 'TWILIO_ACCOUNT_SID', purpose: 'Real Twilio account (not set: Twilio trials are not offered in the Philippines)' },
  { name: 'SLACK_WEBHOOK_URL', purpose: 'Hand-off and monitoring alerts' },
  { name: 'SHOPIFY_STORE_DOMAIN', purpose: 'Shopify development store for live SMS' },
];

export default async function SystemPage() {
  const { db, info } = await relay();
  let roundTrip: number | null = null;
  let dbOk = true;
  try {
    await db.sql.query('select 1');
    const t0 = performance.now();
    await db.sql.query('select 1');
    roundTrip = Math.round((performance.now() - t0) * 10) / 10;
  } catch {
    dbOk = false;
  }
  const variant = getVariant(process.env.RELAY_VARIANT?.trim() || DEFAULT_VARIANT);
  // The prompt is shown for transparency; the canary string that detects prompt leaks stays private.
  const prompt = buildSystemPrompt(variant).replace(/RLY-CANARY-[A-Z0-9]+/g, '[canary redacted]');
  const tools = toolsFor(variant);
  const rpm = Number(process.env.RELAY_GEMINI_RPM) || 12;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="System" description="What is running right now. Secrets are never shown: settings only say whether they are set." />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="size-4 text-muted-foreground" /> Runtime
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
              <Row label="Database">
                <span className="inline-flex items-center gap-1.5">
                  <span className={dbOk ? 'size-2 rounded-full bg-success' : 'size-2 rounded-full bg-destructive'} aria-hidden="true" />
                  {info.database}
                </span>
              </Row>
              <Row label="Round trip">{roundTrip === null ? '–' : `${roundTrip} ms`}</Row>
              <Row label="Region">
                <span className="font-mono text-xs">{process.env.VERCEL_REGION ?? 'local'}</span>
              </Row>
              <Row label="Deployment">
                <span className="font-mono text-xs break-all">{process.env.VERCEL_DEPLOYMENT_ID?.slice(0, 16) ?? 'local'}</span>
              </Row>
              <Row label="Store">{info.store}</Row>
            </dl>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wrench className="size-4 text-muted-foreground" /> Agent
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
              <Row label="Model">
                <span className="font-mono text-xs break-all">{info.model}</span>
              </Row>
              <Row label="Prompt">
                <span className="font-mono text-xs">{variant.id}</span>
              </Row>
              <Row label="Retrieval">
                <span className="font-mono text-xs">{RETRIEVAL_VERSION}</span>
              </Row>
              <Row label="Pacing">{rpm} requests / minute</Row>
              <Row label="Max wait">{Math.round(MAX_RATE_LIMIT_WAIT_MS / 1000)} s, then fallback reply</Row>
              <Row label="Tools">{tools.length}</Row>
            </dl>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Settings</CardTitle>
            <CardDescription>Set in the host&apos;s environment, never in the code</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2.5 text-sm">
              {SETTINGS.map((s) => {
                const set = Boolean(process.env[s.name]?.trim());
                return (
                  <li key={s.name} className="flex items-start gap-2">
                    {set ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                    <div className="min-w-0">
                      <p className="font-mono text-xs">
                        {s.name} <span className="font-sans text-muted-foreground">· {set ? 'set' : 'not set'}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">{s.purpose}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="gap-0 overflow-hidden py-0 shadow-none">
          <CardHeader className="border-b py-4">
            <CardTitle>System prompt</CardTitle>
            <CardDescription>
              Exactly what the model receives as <span className="font-mono">{variant.id}</span>, read-only. Changed only through an A/B decision.
            </CardDescription>
          </CardHeader>
          <ScrollArea className="h-[460px]">
            <pre className="p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">{prompt}</pre>
          </ScrollArea>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Tools</CardTitle>
            <CardDescription>Every action is checked again in code, whatever the model asks</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3">
              {tools.map((t) => (
                <li key={t.name}>
                  <p className="font-mono text-xs font-medium">{t.name}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t.description}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </>
  );
}
