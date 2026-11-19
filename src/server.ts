// Relay's HTTP server: the real inbound channel endpoints.
//
//   POST /webhooks/twilio/sms   Twilio "A message comes in" webhook (form-encoded), answered with TwiML
//   GET  /health                liveness check
//
// Every request goes through the same handleInbound() as the simulator and the
// eval suite. No Twilio account is needed to run or test this: `npm run sms`
// sends correctly signed fake requests.
//
//   npm run server                         listen on http://127.0.0.1:3000
//   npm run server -- --offline            scripted stand-in model (no API quota)
//   npm run server -- --store shopify      answer from your Shopify dev store (needs SHOPIFY_* in .env)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseArgs } from 'node:util';
import { loadEnv } from './config.ts';
import { createModel } from './agent/providers.ts';
import { DEFAULT_VARIANT, getVariant } from './agent/variants.ts';
import { validTwilioSignature } from './channels/twilio.ts';
import { handleTwilioSms, type EscalationInfo } from './channels/twilioFlow.ts';
import { RelayDb } from './db/db.ts';
import type { Escalation, HandlerDeps } from './handler.ts';
import { createStore } from './store/fromEnv.ts';
import { escalationAlertFromEnv } from './alerts/slack.ts';

/** Used only when the server is NOT exposed publicly (no RELAY_PUBLIC_URL) and no real token is set. */
export const LOCAL_DEV_TWILIO_TOKEN = 'relay-local-dev-token-not-a-secret';

export type { EscalationInfo };

export type ServerConfig = {
  /** Twilio auth token used to verify X-Twilio-Signature. */
  twilioAuthToken: string;
  /** Public base URL Twilio calls (e.g. a tunnel URL). Signatures are computed over it. Defaults to http://<Host header>. */
  publicUrl?: string;
  /** Called after a conversation is handed to a person (e.g. a Slack alert). */
  onEscalation?: (e: Escalation, info: EscalationInfo) => Promise<void>;
  log?: (s: string) => void;
};

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

export function createRelayServer(deps: HandlerDeps, cfg: ServerConfig): Server {
  const log = cfg.log ?? ((s: string) => console.log(s));

  async function twilioSms(req: IncomingMessage, res: ServerResponse) {
    const raw = await readBody(req);
    const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
    const url = `${(cfg.publicUrl ?? `http://${req.headers.host}`).replace(/\/$/, '')}${req.url}`;
    const signature = req.headers['x-twilio-signature'];
    if (!validTwilioSignature(cfg.twilioAuthToken, url, params, Array.isArray(signature) ? signature[0] : signature)) {
      log(`  rejected: bad or missing X-Twilio-Signature (url ${url})`);
      return send(res, 403, 'invalid signature');
    }
    // The local server answers in sync mode (reply inside the TwiML). The deployed route uses async mode.
    const r = await handleTwilioSms(deps, { mode: 'sync', onEscalation: cfg.onEscalation, log }, params);
    return send(res, r.status, r.body, r.contentType);
  }

  return createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/health') return send(res, 200, 'ok');
    if (req.method === 'POST' && path === '/webhooks/twilio/sms') {
      twilioSms(req, res).catch((err) => {
        log(`  webhook error: ${(err as Error).message}`);
        if (!res.headersSent) send(res, (err as { status?: number }).status ?? 500, 'error');
      });
      return;
    }
    send(res, 404, 'not found');
  });
}

/* ------------------------------------------------------------------ main */

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/server.ts');
if (isMain) {
  loadEnv();
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: process.env.PORT ?? '3000' },
      host: { type: 'string', default: '127.0.0.1' },
      offline: { type: 'boolean', default: false },
      provider: { type: 'string' },
      model: { type: 'string' },
      variant: { type: 'string', default: DEFAULT_VARIANT },
      store: { type: 'string', default: 'mock' },
    },
  });
  const publicUrl = process.env.RELAY_PUBLIC_URL?.trim() || undefined;
  let token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!token) {
    if (publicUrl || values.host !== '127.0.0.1') {
      console.error('TWILIO_AUTH_TOKEN must be set when the server is reachable from outside this machine. Put it in .env.');
      process.exit(1);
    }
    token = LOCAL_DEV_TWILIO_TOKEN;
    console.warn('No TWILIO_AUTH_TOKEN: using the local-only dev token (fine for `npm run sms`, never for a public URL).');
  }
  const db = await RelayDb.open();
  const deps: HandlerDeps = {
    db,
    store: createStore(values.store),
    model: createModel({ provider: values.provider, model: values.model, offline: values.offline }),
    variant: getVariant(values.variant!),
  };
  const onEscalation = escalationAlertFromEnv();
  const server = createRelayServer(deps, { twilioAuthToken: token, publicUrl, onEscalation });
  server.listen(Number(values.port), values.host, () => {
    console.log(`Relay server on http://${values.host}:${values.port}  (model ${deps.model.offline ? 'OFFLINE stub' : `${deps.model.provider}:${deps.model.modelId}`}, variant ${deps.variant.id}, store ${values.store})`);
    console.log(`  SMS webhook: POST ${publicUrl ?? `http://${values.host}:${values.port}`}/webhooks/twilio/sms`);
    console.log(`  Hand-off alerts: ${onEscalation ? 'Slack' : 'off (set SLACK_WEBHOOK_URL)'}`);
  });
}
