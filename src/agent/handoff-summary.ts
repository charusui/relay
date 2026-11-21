// Hand-off summaries are read by a support teammate (Slack alert, dashboard,
// queue), so they must read like a note from a colleague. The escalateToHuman
// tool description asks the model for that; this is the code safety net for
// when it slips: internal reason codes, tool names and "I must escalate"
// clauses are rewritten or removed before a summary is stored or shown.

const REASON_WORDS: Record<string, string> = {
  low_confidence: 'no clear answer',
  angry_customer: 'an upset customer',
  refund_over_threshold: 'a refund that needs approval',
};

const TOOL_WORDS: Record<string, string> = {
  lookupOrder: 'the order lookup',
  getTrackingStatus: 'the tracking check',
  checkReturnEligibility: 'the return eligibility check',
  startReturn: 'the return',
  applyDiscountCode: 'the discount code check',
  searchPolicy: 'the store policies',
  escalateToHuman: 'a hand-off',
};

// A clause where the agent narrates its own hand-off: "so I must escalate with low_confidence",
// "I will hand this off", "Escalating to a human." Removed up to the end of its sentence.
const SELF_HANDOFF =
  /(?:[,;]\s*|\s+)?(?:\b(?:so|and|therefore|thus|hence)\s+)?\b(?:I(?:'ll| will| must| need to| have to| should| am going to| am)?|we(?:'ll| will| must| need to| should)?)\s+(?:escalat\w*|hand(?:ing)?\s+(?:this|it|the conversation|the customer)?\s*(?:off|over)|pass(?:ing)?\s+(?:this|it)\s+(?:on|to))\b[^.!?]*|\bescalating\b[^.!?]*/gi;

/** Plain-English version of a hand-off summary, safe to show a teammate. */
export function cleanHandoffSummary(raw: string): string {
  let s = (raw ?? '').replace(/`/g, '');
  // "Escalating with reason angry_customer: customer is upset..." keeps what follows the colon.
  s = s.replace(/(^|[.!?]\s+)(?:escalat\w*|handing\s+(?:this\s+)?off)\b[^.!?:]*:\s*/gi, '$1');
  s = s.replace(SELF_HANDOFF, '');
  for (const [code, words] of Object.entries(REASON_WORDS)) s = s.replace(new RegExp(`\\b(?:with|as|reason:?)?\\s*${code}\\b`, 'gi'), ` ${words}`);
  for (const [tool, words] of Object.entries(TOOL_WORDS)) s = s.replace(new RegExp(`\\b${tool}(?:\\(\\))?`, 'g'), words);
  s = s
    .replace(/\(\s+/g, '(')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/([,;:])(?=[.!?]|$)/g, '')
    .replace(/([.!?])(?:\s*[.!?])+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[.!?,;:\s]+/, '')
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
  if (!/[a-z0-9]/i.test(s)) return 'A customer needs a teammate. Open the conversation for details.';
  if (!/[.!?"”)]$/.test(s)) s += '.';
  return s;
}
