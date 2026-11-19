// Send one example hand-off alert to the Slack webhook in .env, to check
// the link works. Uses a made-up conversation; no customer data.
//
//   npm run slack-test

import { loadEnv } from '../config.ts';
import { slackEscalationAlert } from '../alerts/slack.ts';

loadEnv();
const url = process.env.SLACK_WEBHOOK_URL?.trim();
if (!url) {
  console.error('SLACK_WEBHOOK_URL is not set in .env.');
  process.exit(1);
}
try {
  await slackEscalationAlert(url)(
    { reason: 'refund_over_threshold', source: 'agent', ticketId: 'esc_test0001', summary: 'TEST ALERT from `npm run slack-test`. Priya wants to return the Summit Down Jacket from order 1003; eligible, but the $249 refund is over $150 and needs approval.' },
    { conversationId: 'conv_test', channel: 'sms', from: '+15550100103', text: "I'd like to return the down jacket from 1003, too warm" },
  );
  console.log('Sent. Check your Slack channel for the test hand-off alert.');
} catch (err) {
  console.error(`Slack test failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
