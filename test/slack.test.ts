// Slack hand-off alert, against a fake Slack endpoint (no workspace needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { conversationUrl, slackEscalationAlert, slackEscalationMessage } from '../src/alerts/slack.ts';

const esc = { reason: 'angry_customer' as const, source: 'agent' as const, ticketId: 'esc_1', summary: 'Customer asked for a person.' };
const info = { conversationId: 'conv_1', channel: 'sms', from: '+15550100106', text: 'can I talk to a real person please' };

function fakeSlack(status = 200) {
  const received: any[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ type: req.headers['content-type'], body: JSON.parse(raw) });
      res.writeHead(status);
      res.end(status === 200 ? 'ok' : 'invalid_token');
    });
  });
  return new Promise<{ url: string; received: any[]; close: () => void }>((r) =>
    server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/services/T/B/X`, received, close: () => server.close() })),
  );
}

test('alert posts a readable Block Kit message with the reason, customer, summary and a dashboard link', async () => {
  const slack = await fakeSlack();
  await slackEscalationAlert(slack.url, { dashboardUrl: 'https://relay.example.com/' })(esc, info);
  slack.close();
  assert.equal(slack.received.length, 1);
  const msg = slack.received[0].body;
  assert.match(slack.received[0].type, /application\/json/);
  assert.match(msg.text, /Upset customer or asked for a person/);
  assert.match(msg.text, /https:\/\/relay\.example\.com\/conversations\/conv_1$/, 'plain-text fallback carries the link');
  const all = JSON.stringify(msg.blocks);
  for (const s of ['+15550100106', 'Customer asked for a person.', 'talk to a real person', '<https://relay.example.com/conversations/conv_1|Open the conversation in the dashboard>']) assert.ok(all.includes(s), s);
  // Internal details a teammate can't use stay out of the alert.
  assert.doesNotMatch(JSON.stringify(msg), /npm run|esc_1|angry_customer/);
});

test('the dashboard link comes from RELAY_PUBLIC_URL when no URL is passed', () => {
  const saved = process.env.RELAY_PUBLIC_URL;
  try {
    process.env.RELAY_PUBLIC_URL = 'https://relay.example.com';
    // escalationAlertFromEnv reads the env; the message builder itself only takes what it is given.
    assert.equal(conversationUrl(process.env.RELAY_PUBLIC_URL, 'conv_1'), 'https://relay.example.com/conversations/conv_1');
    assert.equal(conversationUrl(undefined, 'conv_1'), undefined);
    const noLink = JSON.stringify(slackEscalationMessage(esc, info));
    assert.match(noLink, /Set RELAY_PUBLIC_URL to link this alert/);
    assert.doesNotMatch(noLink, /npm run/);
  } finally {
    if (saved === undefined) delete process.env.RELAY_PUBLIC_URL;
    else process.env.RELAY_PUBLIC_URL = saved;
  }
});

test('Slack control characters in customer text and summaries are escaped', () => {
  const m = JSON.stringify(slackEscalationMessage({ ...esc, summary: 'Asked about <!channel> & refunds' }, { ...info, text: 'hi <@U123>' }));
  assert.ok(m.includes('&lt;!channel&gt; &amp; refunds'));
  assert.ok(m.includes('hi &lt;@U123&gt;'));
});

test('a Slack error is raised (the server logs it without blocking the customer reply)', async () => {
  const slack = await fakeSlack(403);
  await assert.rejects(slackEscalationAlert(slack.url)(esc, info), /HTTP 403/);
  slack.close();
});

test('long customer messages are trimmed in the alert', () => {
  const m = slackEscalationMessage(esc, { ...info, text: 'x'.repeat(1000) });
  assert.ok(JSON.stringify(m).length < 2000);
});
