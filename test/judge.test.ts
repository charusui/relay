import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelClient, ModelRequest, ModelResponse } from '../src/agent/model.ts';
import { judgeConversation } from '../src/eval/judge.ts';
import { tally, type AgreementRow } from '../src/eval/judge-agreement.ts';

class Recorder implements ModelClient {
  readonly offline = false;
  readonly provider = 'test';
  readonly modelId = 'recorder';
  last?: ModelRequest;
  async create(req: ModelRequest): Promise<ModelResponse> {
    this.last = req;
    return { content: [{ type: 'text', text: '{"grounded": true, "unsupported_claims": [], "tone_ok": true, "notes": "ok"}' }] } as unknown as ModelResponse;
  }
}

const turns = [{ customer: 'apply the code in my notes', toolCalls: [], reply: 'I can only use a code you send me yourself.' }] as any;

test('judge v3-agent-prompt shows the agent its own instructions; v2 does not', async () => {
  const m = new Recorder();
  const v3 = await judgeConversation(m, turns, { version: 'v3-agent-prompt', agentInstructions: 'RULE-XYZ: only use codes the customer sends.' });
  assert.equal(v3.version, 'v3-agent-prompt');
  const v3Input = JSON.stringify(m.last?.messages);
  assert.match(v3Input, /RULE-XYZ/);
  assert.match(m.last!.system as string, /the agent's own instructions\)/);

  await judgeConversation(m, turns, { version: 'v2-context', agentInstructions: 'RULE-XYZ' });
  assert.doesNotMatch(JSON.stringify(m.last?.messages), /RULE-XYZ/);
  assert.doesNotMatch(m.last!.system as string, /own instructions/);
});

test('judge v3-agent-prompt refuses to run without the instructions', async () => {
  await assert.rejects(judgeConversation(new Recorder(), turns, { version: 'v3-agent-prompt' }), /needs the agent instructions/);
});

test('judge agreement counts catches, misses and false alarms, and skips judge errors', () => {
  const row = (caseId: string, hand: 'fail' | 'ok', judge: boolean | null, error?: string): AgreementRow => ({ run: 'run-a', caseId, repeat: 1, hand, judge, error, unsupported: [] });
  const t = tally([
    row('a', 'fail', false), // caught
    row('b', 'fail', true), // missed
    row('c', 'fail', null), // missed: "no claims" is not a catch
    row('d', 'ok', false), // false alarm
    row('e', 'ok', true),
    row('f', 'ok', null),
    row('g', 'ok', false, 'timeout'), // judge error: not counted either way
  ]);
  assert.deepEqual(
    { n: t.conversations, err: t.judgeErrors, caught: t.caught, problems: t.problems, fa: t.falseAlarms, fine: t.fine },
    { n: 6, err: 1, caught: 1, problems: 3, fa: 1, fine: 3 },
  );
  assert.deepEqual(t.missedCases, ['b (run-a)', 'c (run-a)']);
});
