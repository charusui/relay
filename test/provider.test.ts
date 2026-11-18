// The free-provider HTTP path, against a fake local OpenAI-compatible server:
// tool calls come back as tool_use blocks, a per-minute 429 is retried, and a
// daily-quota 429 stops the run so it can resume (PLAN.md 4.12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAIChatModel, QuotaExhaustedError, providerWaitMs } from '../src/agent/openaiCompat.ts';

function fakeServer(responses: { status: number; body: object; headers?: Record<string, string> }[]) {
  const seen: any[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push(JSON.parse(raw || '{}'));
      const r = responses.shift() ?? { status: 500, body: { error: 'no more responses' } };
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.body));
    });
  });
  return new Promise<{ url: string; seen: any[]; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => server.close() })),
  );
}

const toolReply = {
  model: 'fake-model',
  choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookupOrder', arguments: '{"orderNumber":"1042"}' } }] } }],
  usage: { prompt_tokens: 120, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 20 } },
};

test('tool call round trip, with one per-minute 429 retried and its wait recorded', async () => {
  const srv = await fakeServer([{ status: 429, body: { error: 'rate limit per minute' }, headers: { 'retry-after': '1' } }, { status: 200, body: toolReply }]);
  const m = new OpenAIChatModel({ provider: 'fake', baseUrl: srv.url, apiKey: 'test', modelId: 'fake-model', rpm: 0 });
  const r = await m.create({
    system: 'sys',
    context: 'ctx',
    tools: [{ name: 'lookupOrder', description: 'd', input_schema: { type: 'object', properties: {}, additionalProperties: false } as any }],
    messages: [{ role: 'user', content: 'where is 1042' }],
  });
  srv.close();
  assert.equal(r.stopReason, 'tool_use');
  const tu = r.content.find((b) => b.type === 'tool_use') as any;
  assert.equal(tu.name, 'lookupOrder');
  assert.deepEqual(tu.input, { orderNumber: '1042' });
  assert.equal(r.usage.inputTokens, 100); // 120 prompt - 20 cached
  assert.equal(r.usage.cacheReadTokens, 20);
  assert.ok(r.waitMs >= 1000, `waitMs ${r.waitMs}`);
  assert.equal(srv.seen[1].tools[0].function.name, 'lookupOrder');
  assert.equal(srv.seen[1].messages[0].role, 'system');
});

test('provider wait times are read from header, Gemini body and Groq message', () => {
  assert.equal(providerWaitMs('12', ''), 12_000);
  assert.equal(providerWaitMs(null, '{"details":[{"retryDelay":"39s"}]}'), 39_000);
  assert.equal(providerWaitMs(null, 'Rate limit reached on tokens per day (TPD). Please try again in 7m12.5s.'), 432_500);
  assert.equal(providerWaitMs(null, 'Please try again in 2h3m'), 7_380_000);
  assert.equal(providerWaitMs(null, 'quota exceeded'), null);
});

test('a daily limit with a long requested wait stops; a short one is waited out', async () => {
  const long = await fakeServer([{ status: 429, body: { error: { message: 'Rate limit reached on tokens per day (TPD). Please try again in 2h3m.' } } }]);
  const m1 = new OpenAIChatModel({ provider: 'fake', baseUrl: long.url, modelId: 'm', rpm: 0 });
  await assert.rejects(m1.create({ system: 's', context: '', tools: [], messages: [{ role: 'user', content: 'hi' }] }), QuotaExhaustedError);
  long.close();
  const short = await fakeServer([
    { status: 429, body: { error: { message: 'Rate limit reached on tokens per day (TPD). Please try again in 1.2s.' } } },
    { status: 200, body: { model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } },
  ]);
  const m2 = new OpenAIChatModel({ provider: 'fake', baseUrl: short.url, modelId: 'm', rpm: 0 });
  const r = await m2.create({ system: 's', context: '', tools: [], messages: [{ role: 'user', content: 'hi' }] });
  short.close();
  assert.equal(r.stopReason, 'end_turn');
  assert.ok(r.waitMs >= 1200);
});

test('a daily-quota 429 with no retry time stops after a few tries', async () => {
  const srv = await fakeServer([0, 1, 2].map(() => ({ status: 429, body: { error: { message: 'Quota exceeded: GenerateRequestsPerDayPerProjectPerModel-FreeTier' } } })));
  const m = new OpenAIChatModel({ provider: 'fake', baseUrl: srv.url, modelId: 'fake-model', rpm: 0, backoffBaseMs: 10 });
  await assert.rejects(m.create({ system: 's', context: '', tools: [], messages: [{ role: 'user', content: 'hi' }] }), QuotaExhaustedError);
  srv.close();
});

test('rpm cap: a burst up to the cap goes out at once, the next call waits for the window', async () => {
  const srv = await fakeServer([200, 200, 200].map((status) => ({ status, body: toolReply })));
  const m = new OpenAIChatModel({ provider: 'fake', baseUrl: srv.url, modelId: 'm', rpm: 2, rpmWindowMs: 400 });
  const req = { system: 's', context: 'c', tools: [], messages: [{ role: 'user' as const, content: 'hi' }] };
  const t0 = Date.now();
  const a = await m.create(req);
  const b = await m.create(req);
  const burstMs = Date.now() - t0;
  const c = await m.create(req);
  const totalMs = Date.now() - t0;
  srv.close();
  assert.ok(burstMs < 300, `first two calls should not wait (took ${burstMs} ms)`);
  assert.equal(a.waitMs + b.waitMs, 0);
  assert.ok(totalMs >= 380, `third call should wait for the window (total ${totalMs} ms)`);
  assert.ok(c.waitMs > 0);
});

const malformed = {
  model: 'fake-model',
  choices: [{ finish_reason: 'function_call_filter: MALFORMED_FUNCTION_CALL', message: { content: null } }],
  usage: { prompt_tokens: 100, completion_tokens: 0 },
};

test('a malformed Gemini tool call is retried once; tokens from both attempts are counted', async () => {
  const srv = await fakeServer([
    { status: 200, body: malformed },
    { status: 200, body: toolReply },
  ]);
  const m = new OpenAIChatModel({ provider: 'fake', baseUrl: srv.url, modelId: 'm', rpm: 0 });
  const r = await m.create({ system: 's', context: 'c', tools: [], messages: [{ role: 'user', content: 'hi' }] });
  srv.close();
  assert.equal(srv.seen.length, 2);
  assert.equal(r.stopReason, 'tool_use');
  assert.equal(r.usage.inputTokens, 100 + 120 - 20);
  assert.equal(r.usage.cacheReadTokens, 20);
});

test('two malformed calls in a row are returned as is (the agent loop then hands off safely)', async () => {
  const srv = await fakeServer([
    { status: 200, body: malformed },
    { status: 200, body: malformed },
    { status: 200, body: toolReply },
  ]);
  const m = new OpenAIChatModel({ provider: 'fake', baseUrl: srv.url, modelId: 'm', rpm: 0 });
  const r = await m.create({ system: 's', context: 'c', tools: [], messages: [{ role: 'user', content: 'hi' }] });
  srv.close();
  assert.equal(srv.seen.length, 2);
  assert.equal(r.content.length, 0);
  assert.match(String(r.stopReason), /MALFORMED_FUNCTION_CALL/);
});
