// Slack alert when a conversation is handed to a person, via a Slack
// "Incoming Webhook" URL (free Slack workspace, no paid plan needed).
// The teammate gets the reason, who, what was said, the agent's hand-off
// summary, and the command to open the full thread.

import type { Escalation } from '../handler.ts';

export type EscalationAlertInfo = { conversationId: string; channel: string; from: string; text: string };

const REASON_LABEL: Record<string, string> = {
  angry_customer: 'Upset customer or asked for a person',
  refund_over_threshold: 'Refund over $150 needs approval',
  low_confidence: 'Agent could not answer confidently',
};

/** Slack message payload (Block Kit, with a plain-text fallback). */
export function slackEscalationMessage(e: Escalation, info: EscalationAlertInfo) {
  const reason = REASON_LABEL[e.reason] ?? e.reason;
  const who = `${info.channel.toUpperCase()} ${info.from}`;
  const quote = info.text.length > 300 ? `${info.text.slice(0, 300)}…` : info.text;
  return {
    text: `Relay hand-off: ${reason} (${who})`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `Hand-off: ${reason}` } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Customer*\n${who}` },
          { type: 'mrkdwn', text: `*Raised by*\n${e.source === 'agent' ? 'the agent' : 'a code safety net'}` },
        ],
      },
      { type: 'section', text: { type: 'mrkdwn', text: `*Last message*\n>${quote.replace(/\n/g, '\n>')}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Summary*\n${e.summary}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Ticket \`${e.ticketId}\` · open the thread: \`npm run queue -- --show ${info.conversationId}\`` }] },
    ],
  };
}

/** Returns an onEscalation hook that posts to Slack. Throws on failure; callers log it without blocking the reply. */
export function slackEscalationAlert(webhookUrl: string) {
  return async (e: Escalation, info: EscalationAlertInfo) => {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(slackEscalationMessage(e, info)),
    });
    if (!res.ok) throw new Error(`Slack webhook returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}

/** The alert hook from the environment, or undefined when SLACK_WEBHOOK_URL is not set. */
export function escalationAlertFromEnv() {
  const url = process.env.SLACK_WEBHOOK_URL?.trim();
  return url ? slackEscalationAlert(url) : undefined;
}

/** Plain-text Slack poster for monitoring alerts. Throws on failure (the alert is still recorded). */
export function slackTextNotifier(webhookUrl: string) {
  return async (text: string) => {
    const res = await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`Slack webhook returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}

/** Monitoring-alert notifier from the environment, or undefined when SLACK_WEBHOOK_URL is not set. */
export function monitoringNotifierFromEnv() {
  const url = process.env.SLACK_WEBHOOK_URL?.trim();
  return url ? slackTextNotifier(url) : undefined;
}
