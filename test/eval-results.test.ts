// Every number on the dashboard's Evals page comes from data/eval-results.json.
// This test checks each one against the committed report it cites, so the page
// can never show a figure that isn't in a report (PLAN.md: never invent metrics).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync('data/eval-results.json', 'utf8'));
const frac = ([a, b]: number[]) => `(${a}/${b})`;

test('eval-results.json versions match their full reports', () => {
  for (const v of data.versions) {
    assert.ok(existsSync(v.source), `${v.id}: missing ${v.source}`);
    const r = readFileSync(v.source, 'utf8');
    assert.ok(r.includes(v.run), `${v.id}: run id not in report`);
    assert.ok(r.includes(`| Variant | \`${v.variant}\``), `${v.id}: variant`);
    const row = (label: string) => r.split('\n').find((l) => l.startsWith(`| ${label} | **`)) ?? '';
    const m = v.metrics;
    assert.ok(row('Resolution accuracy').includes(frac(m.resolution)), `${v.id}: resolution`);
    assert.ok(row('Correct tool use').includes(frac(m.toolUse)), `${v.id}: tool use`);
    assert.ok(row('Unnecessary escalations').includes(frac(m.unnecessaryEscalations)), `${v.id}: unnecessary`);
    assert.ok(row('Missed escalations').includes(frac(m.missedEscalations)), `${v.id}: missed`);
    assert.ok(row('Groundedness').includes(frac(m.groundednessJudge)), `${v.id}: groundedness (judge)`);
    assert.ok(row('Tokens per conversation').includes(`**${m.tokensPerConversation}**`), `${v.id}: tokens`);
    assert.ok(row('Latency p50 / p95').includes(`**${m.latencyP50s.toFixed(2)} s / ${m.latencyP95s.toFixed(2)} s**`), `${v.id}: latency`);
    const hand = readFileSync(v.groundednessHand.source, 'utf8');
    assert.ok(hand.includes(`${v.groundednessHand.value[0]}/${v.groundednessHand.value[1]}`), `${v.id}: hand-checked groundedness not in ${v.groundednessHand.source}`);
  }
  assert.ok(data.versions.some((v: { id: string }) => v.id === data.currentVersion));
});

test('eval-results.json experiments and failures point at real write-ups', () => {
  for (const e of data.experiments) assert.ok(existsSync(e.doc), e.doc);
  for (const f of data.failures) {
    assert.ok(existsSync(f.doc), f.doc);
    const title = readFileSync(f.doc, 'utf8').split('\n')[0];
    assert.equal(title, `# Failure ${f.id}: ${f.title}`);
  }
});
