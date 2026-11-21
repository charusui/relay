// Slack alert when a conversation is handed to a person, via a Slack
// "Incoming Webhook" URL (free Slack workspace, no paid plan needed).
// The teammate gets the reason, who, what was said, the agent's hand-off
// summary, and a link to the full thread on the dashboard.

import type { Escalation } from '../handler.ts';

export type EscalationAlertInfo = { conversationId: string; channel: string; from: string; text: string };

export type SlackAlertOptions = {
  /** The dashboard's public base URL (e.g. https://relay.example.com). With it, the alert links to the thread. */
  dashboardUrl?: string;
};

const REASON_LABEL: Record<string, string> = {
  angry_customer: 'Upset customer or asked for a person',
  refund_over_threshold: 'Refund over $150 needs approval',
  low_confidence: 'Agent could not answer confidently',
};

/** Slack treats &, < and > as control characters in message text. */
const escapeSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Link to one conversation on the dashboard, or undefined when no base URL is configured. */
export function conversationUrl(dashboardUrl: string | undefined, conversationId: string) {
  const base = dashboardUrl?.trim().replace(/\/+$/, '');
  return base ? `${base}/conversations/${encodeURIComponent(conversationId)}` : undefined;
}

/** Slack message payload (Block Kit, with a plain-text fallback). */
export function slackEscalationMessage(e: Escalation, info: EscalationAlertInfo, opts: SlackAlertOptions = {}) {
  const reason = REASON_LABEL[e.reason] ?? 'Needs a teammate';
  const who = `${info.channel.toUpperCase()} ${info.from}`;
  const quote = info.text.length > 300 ? `${info.text.slice(0, 300)}…` : info.text;
  const link = conversationUrl(opts.dashboardUrl, info.conversationId);
  return {
    text: `Relay hand-off: ${reason} (${who})${link ? ` ${link}` : ''}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `Hand-off: ${reason}` } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Customer*\n${escapeSlack(who)}` },
          { type: 'mrkdwn', text: `*Raised by*\n${e.source === 'agent' ? 'the agent' : 'a code safety net'}` },
        ],
      },
      { type: 'section', text: { type: 'mrkdwn', text: `*Last message*\n>${escapeSlack(quote).replace(/\n/g, '\n>')}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Summary*\n${escapeSlack(e.summary)}` } },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: link ? `<${link}|Open the conversation in the dashboard>` : 'Set RELAY_PUBLIC_URL to link this alert to the dashboard.' }],
      },
    ],
  };
}

/** Returns an onEscalation hook that posts to Slack. Throws on failure; callers log it without blocking the reply. */
export function slackEscalationAlert(webhookUrl: string, opts: SlackAlertOptions = {}) {
  return async (e: Escalation, info: EscalationAlertInfo) => {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(slackEscalationMessage(e, info, opts)),
    });
    if (!res.ok) throw new Error(`Slack webhook returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}

/**
 * The alert hook from the environment, or undefined when SLACK_WEBHOOK_URL is not set.
 * The dashboard link uses `opts.dashboardUrl`, else RELAY_PUBLIC_URL.
 */
export function escalationAlertFromEnv(opts: SlackAlertOptions = {}) {
  const url = process.env.SLACK_WEBHOOK_URL?.trim();
  const dashboardUrl = opts.dashboardUrl ?? (process.env.RELAY_PUBLIC_URL?.trim() || undefined);
  return url ? slackEscalationAlert(url, { dashboardUrl }) : undefined;
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
