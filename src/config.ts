// Store rules that live in code, not in the prompt. Changing one of these
// changes behaviour for every variant and is picked up by the eval suite.

/** A return or refund worth more than this (USD) needs human approval. */
export const REFUND_APPROVAL_THRESHOLD = 150;

/** Days after delivery during which an item can be returned. Day 30 counts. */
export const RETURN_WINDOW_DAYS = 30;

/** Safety limit on model calls for a single inbound message. */
export const MAX_AGENT_STEPS = 8;

/** Load relay/.env if present (Node's built-in loader; no dotenv dependency). */
export function loadEnv() {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: fine for offline runs and tests.
  }
}
