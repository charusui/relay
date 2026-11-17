// What happens to one inbound Twilio SMS after its signature has been checked.
// Shared by the local Node server (src/server.ts) and the deployed Next.js
// route (app/api/twilio/sms/route.ts), so both behave the same.
//
// Two reply modes:
//  - sync:  run the agent, answer the webhook with TwiML containing the reply.
//           Simple, but Twilio gives up after about 15 s, and free-tier replies
//           can take longer.
//  - async: answer the webhook at once with empty TwiML, then run the agent in
//           the background and send the reply through Twilio's Messages API.
//           Used when deployed.

import { describeModelError } from '../agent/model.ts';
import { HANDOFF_LINE, handleInbound, type Escalation, type HandlerDeps } from '../handler.ts';
import type { Traffic } from '../db/db.ts';
import { normalizeContact } from '../store/store.ts';
import { HELP_TEXT, START_TEXT, smsKeyword, twiml } from './twilio.ts';

export const FALLBACK_REPLY = `Sorry, we're having trouble replying right now. ${HANDOFF_LINE}`;

export type EscalationInfo = { conversationId: string; channel: string; from: string; text: string };

/** Sends one SMS (async mode). to = the customer, from = your Twilio number. */
export type SendSms = (to: string, from: string, body: string) => Promise<void>;

export type TwilioFlowConfig = {
  mode: 'sync' | 'async';
  sendSms?: SendSms;
  onEscalation?: (e: Escalation, info: EscalationInfo) => Promise<void>;
  /** Called after each answered or failed message (e.g. alert rules). Errors are logged, never shown to the customer. */
  afterMessage?: () => Promise<void>;
  traffic?: Traffic;
  log?: (s: string) => void;
};

export type TwilioFlowResult = {
  status: number;
  body: string;
  contentType: string;
  /** Async mode: work to run after the webhook has been answered. */
  background?: () => Promise<void>;
};

const XML = 'text/xml; charset=utf-8';
const ok = (message?: string): TwilioFlowResult => ({ status: 200, body: twiml(message), contentType: XML });

export async function handleTwilioSms(deps: HandlerDeps, cfg: TwilioFlowConfig, params: Record<string, string>): Promise<TwilioFlowResult> {
  const log = cfg.log ?? ((s: string) => console.log(s));
  const { From: from, To: ourNumber, Body: body = '', MessageSid: sid } = params;
  if (!from || !sid) return { status: 400, body: 'missing From or MessageSid', contentType: 'text/plain; charset=utf-8' };
  if (cfg.mode === 'async' && (!cfg.sendSms || !ourNumber)) throw new Error('async mode needs sendSms and the To parameter');
  const contact = normalizeContact(from);
  const traffic = cfg.traffic ?? 'live';

  // Twilio retries on timeouts and errors: the same MessageSid must never act twice.
  const claim = await deps.db.claimInboundEvent('twilio', sid);
  if (claim.duplicate) {
    log(`  duplicate ${sid}: agent not run`);
    // In async mode the reply went out as its own message; answering again would send it twice.
    return ok(cfg.mode === 'sync' ? (claim.reply ?? undefined) : undefined);
  }

  const keyword = smsKeyword(body);
  if (keyword === 'stop') {
    await deps.db.setSmsOptOut(contact, true);
    await deps.db.completeInboundEvent('twilio', sid, null, null);
    log(`  ${contact} opted out (STOP)`);
    return ok(); // Twilio sends the carrier opt-out confirmation itself
  }
  if (keyword === 'start') {
    await deps.db.setSmsOptOut(contact, false);
    await deps.db.completeInboundEvent('twilio', sid, null, START_TEXT);
    return ok(START_TEXT);
  }
  if (keyword === 'help') {
    await deps.db.completeInboundEvent('twilio', sid, null, HELP_TEXT);
    return ok(HELP_TEXT);
  }
  if (await deps.db.isSmsOptedOut(contact)) {
    await deps.db.completeInboundEvent('twilio', sid, null, null);
    log(`  ${contact} is opted out: message logged, no reply`);
    return ok();
  }

  // Runs the agent; never throws. Returns the text the customer should get.
  const answer = async (): Promise<string> => {
    let reply: string;
    try {
      const r = await handleInbound(deps, { channel: 'sms', from: contact, text: body, traffic });
      await deps.db.completeInboundEvent('twilio', sid, r.conversationId, r.reply);
      log(`  ${contact} -> ${r.reply.slice(0, 80).replace(/\n/g, ' ')}${r.escalation ? `  [escalated: ${r.escalation.reason}]` : ''}`);
      if (r.escalation && cfg.onEscalation) {
        // An alert failing must never break the customer's reply.
        await cfg.onEscalation(r.escalation, { conversationId: r.conversationId, channel: 'sms', from: contact, text: body }).catch((err) => log(`  escalation alert failed: ${(err as Error).message}`));
      }
      reply = r.reply;
    } catch (err) {
      const message = describeModelError(err);
      log(`  agent error for ${sid}: ${message}`);
      await deps.db.recordFailure({ traffic, source: 'twilio', message }).catch(() => {});
      await deps.db.completeInboundEvent('twilio', sid, null, FALLBACK_REPLY).catch(() => {});
      reply = FALLBACK_REPLY;
    }
    if (cfg.afterMessage) await cfg.afterMessage().catch((err) => log(`  after-message hook failed: ${(err as Error).message}`));
    return reply;
  };

  if (cfg.mode === 'sync') return ok(await answer());

  return {
    ...ok(),
    background: async () => {
      const reply = await answer();
      try {
        await cfg.sendSms!(contact, ourNumber, reply);
      } catch (err) {
        const message = `sending the reply failed: ${(err as Error).message}`;
        log(`  ${message}`);
        await deps.db.recordFailure({ traffic, source: 'twilio-send', message }).catch(() => {});
      }
    },
  };
}
