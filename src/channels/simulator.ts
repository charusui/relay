// Local channel simulator: chat with Relay as a customer over "SMS" or
// "email" in the terminal. Messages go through the same handleInbound() that
// the real SMS and email webhooks will use in milestone 2.
//
//   npm run chat                                   SMS as Maya Chen (+15550100101)
//   npm run chat -- --channel email --from priya.n@example.com
//   npm run chat -- --offline                      scripted stand-in model, no API key
//   npm run chat -- --provider groq --debug        another free provider; show tool calls
//   npm run chat -- --store shopify                answer from your Shopify dev store (needs SHOPIFY_* in .env)

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import { loadEnv } from '../config.ts';
import { describeModelError } from '../agent/model.ts';
import { createModel } from '../agent/providers.ts';
import { totalTokens } from '../agent/pricing.ts';
import { DEFAULT_VARIANT, getVariant } from '../agent/variants.ts';
import { RelayDb } from '../db/db.ts';
import { handleInbound } from '../handler.ts';
import { createStore } from '../store/fromEnv.ts';
import type { Channel } from '../agent/tools.ts';
import { escalationAlertFromEnv } from '../alerts/slack.ts';

loadEnv();

const { values } = parseArgs({
  options: {
    channel: { type: 'string', default: 'sms' },
    from: { type: 'string' },
    variant: { type: 'string', default: DEFAULT_VARIANT },
    provider: { type: 'string' },
    model: { type: 'string' },
    offline: { type: 'boolean', default: false },
    debug: { type: 'boolean', default: false },
    store: { type: 'string', default: 'mock' },
  },
});

const channel = values.channel as Channel;
if (channel !== 'sms' && channel !== 'email') throw new Error('--channel must be sms or email');
const from = values.from ?? (channel === 'sms' ? '+15550100101' : 'maya.chen@example.com');
const variant = getVariant(values.variant!);
const model = createModel({ provider: values.provider, model: values.model, offline: values.offline });

const db = await RelayDb.open();
const store = createStore(values.store); // the mock store resets each time the simulator starts
const deps = { db, store, model, variant };
const alert = escalationAlertFromEnv();

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

console.log(bold(`Relay simulator: ${channel.toUpperCase()} from ${from}`));
console.log(dim(`variant ${variant.id} · ${model.offline ? 'OFFLINE scripted stand-in (not a real model)' : `${model.provider}:${model.modelId}`} · store clock ${store.now().toISOString().slice(0, 10)}`));
console.log(dim('Commands: /new (fresh conversation)  /queue (human queue)  /quit'));
if (channel === 'email') console.log(dim('Email: a line starting with "Subject: ..." sets the subject.'));

const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
let subject: string | undefined;
const prompt = () => stdout.write(`\n${bold('you')} > `);
prompt();

for await (const raw of rl) {
  const line = raw.trim();
  if (!line) {
    prompt();
    continue;
  }
  if (!stdin.isTTY) console.log(line); // echo piped input so transcripts read naturally
  if (line === '/quit' || line === '/exit') break;
  if (line === '/new') {
    const conv = await db.findOpenConversation(channel, from);
    if (conv) await db.closeConversation(conv.id);
    console.log(dim('Started a fresh conversation.'));
  } else if (line === '/queue') {
    const q = await db.openEscalations();
    if (!q.length) console.log(dim('Human queue is empty.'));
    for (const e of q) console.log(`${e.id}  ${e.reason}  (${e.source})  ${e.channel} ${e.contact}\n  ${e.summary}`);
  } else if (line.toLowerCase().startsWith('subject:')) {
    subject = line.slice(8).trim();
    console.log(dim(`Subject set: ${subject}`));
  } else {
    try {
      const r = await handleInbound(deps, { channel, from, text: line, subject });
      if (r.escalation && alert) {
        alert(r.escalation, { conversationId: r.conversationId, channel, from, text: line }).catch((err) => console.error(dim(`  Slack alert failed: ${(err as Error).message}`)));
      }
      if (values.debug) {
        for (const c of r.toolCalls) console.log(dim(`  tool ${c.name} ${JSON.stringify(c.input)} -> ${JSON.stringify(c.output).slice(0, 220)}`));
      }
      console.log(`\n${bold('relay')} > ${r.reply}`);
      const meta = [`${(r.activeLatencyMs / 1000).toFixed(2)}s`, `${totalTokens(r.usage)} tokens`, `${r.steps} model call(s)`];
      if (r.waitMs) meta.push(`+${(r.waitMs / 1000).toFixed(1)}s rate-limit wait`);
      if (r.escalation) meta.push(`ESCALATED: ${r.escalation.reason} (by ${r.escalation.source}) ticket ${r.escalation.ticketId}`);
      if (r.heldForHuman) meta.push('held for human');
      console.log(dim(`  ${meta.join(' · ')}`));
    } catch (err) {
      console.error(`\nError: ${describeModelError(err)}`);
    }
  }
  prompt();
}

rl.close();
await db.close();
