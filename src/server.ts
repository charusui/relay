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
import { describeModelError } from './agent/model.ts';
import { createModel } from './agent/providers.ts';
import { DEFAULT_VARIANT, getVariant } from './agent/variants.ts';
import { HELP_TEXT, START_TEXT, smsKeyword, twiml, validTwilioSignature } from './channels/twilio.ts';
import { RelayDb } from './db/db.ts';
import { HANDOFF_LINE, handleInbound, type Escalation, type HandlerDeps } from './handler.ts';
import { normalizeContact } from './store/store.ts';
import { createStore } from './store/fromEnv.ts';
import { escalationAlertFromEnv } from './alerts/slack.ts';

/** Used only when the server is NOT exposed publicly (no RELAY_PUBLIC_URL) and no real token is set. */
export const LOCAL_DEV_TWILIO_TOKEN = 'relay-local-dev-token-not-a-secret';

export type EscalationInfo = { conversationId: string; channel: string; from: string; text: string };

export type ServerConfig = {
  /** Twilio auth token used to verify X-Twilio-Signature. */
  twilioAuthToken: string;
  /** Public base URL Twilio calls (e.g. a tunnel URL). Signatures are computed over it. Defaults to http://<Host header>. */
  publicUrl?: string;
  /** Called after a conversation is handed to a person (e.g. a Slack alert). */
  onEscalation?: (e: Escalation, info: EscalationInfo) => Promise<void>;
  log?: (s: string) => void;
};

const FALLBACK_REPLY = `Sorry, we're having trouble replying right now. ${HANDOFF_LINE}`;

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

const sendTwiml = (res: ServerResponse, message?: string) => send(res, 200, twiml(message), 'text/xml; charset=utf-8');

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
    const { From: from, Body: body = '', MessageSid: sid } = params;
    if (!from || !sid) return send(res, 400, 'missing From or MessageSid');
    const contact = normalizeContact(from);

    // Twilio retries on timeouts and errors: the same MessageSid must never act twice.
    const claim = await deps.db.claimInboundEvent('twilio', sid);
    if (claim.duplicate) {
      log(`  duplicate ${sid}: replaying the stored reply, agent not run`);
      return sendTwiml(res, claim.reply ?? undefined);
    }

    const keyword = smsKeyword(body);
    if (keyword === 'stop') {
      await deps.db.setSmsOptOut(contact, true);
      await deps.db.completeInboundEvent('twilio', sid, null, null);
      log(`  ${contact} opted out (STOP)`);
      return sendTwiml(res); // Twilio sends the carrier opt-out confirmation itself
    }
    if (keyword === 'start') {
      await deps.db.setSmsOptOut(contact, false);
      await deps.db.completeInboundEvent('twilio', sid, null, START_TEXT);
      return sendTwiml(res, START_TEXT);
    }
    if (keyword === 'help') {
      await deps.db.completeInboundEvent('twilio', sid, null, HELP_TEXT);
      return sendTwiml(res, HELP_TEXT);
    }
    if (await deps.db.isSmsOptedOut(contact)) {
      await deps.db.completeInboundEvent('twilio', sid, null, null);
      log(`  ${contact} is opted out: message logged, no reply`);
      return sendTwiml(res);
    }

    try {
      const r = await handleInbound(deps, { channel: 'sms', from: contact, text: body });
      await deps.db.completeInboundEvent('twilio', sid, r.conversationId, r.reply);
      log(`  ${contact} -> ${r.reply.slice(0, 80).replace(/\n/g, ' ')}${r.escalation ? `  [escalated: ${r.escalation.reason}]` : ''}`);
      if (r.escalation && cfg.onEscalation) {
        // An alert failing must never break the customer's reply.
        cfg.onEscalation(r.escalation, { conversationId: r.conversationId, channel: 'sms', from: contact, text: body }).catch((err) => log(`  escalation alert failed: ${(err as Error).message}`));
      }
      return sendTwiml(res, r.reply);
    } catch (err) {
      // Reply with a safe message (status 200, so Twilio does not retry into the same failure).
      log(`  agent error for ${sid}: ${describeModelError(err)}`);
      await deps.db.completeInboundEvent('twilio', sid, null, FALLBACK_REPLY);
      return sendTwiml(res, FALLBACK_REPLY);
    }
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
      console.error('TWILIO_AUTH_TOKEN must be set when the server is reachable from outside this machine. Put it in relay/.env.');
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
