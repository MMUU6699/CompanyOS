import assert from 'node:assert/strict';
import test from 'node:test';
import type { UpstreamDescriptor } from '../domain/descriptor';
import { UpstreamMisconfiguredError } from '../errors';
import {
  assertFreeOpenRouterModelId,
  callUpstream,
  isAllowedFreeOpenRouterModelId,
  openDirectStream,
} from './call-upstream';
import { dispatch } from '../pipeline/dispatch';
import {
  CircuitBreakers,
  openRouterFreeBreakers,
  tripsOpenRouterBreaker,
} from '../pipeline/circuit-breaker';

const FREE_CHAIN = [
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'openrouter/free',
] as const;

function makeDescriptor(model: string, fallbacks?: readonly string[]): UpstreamDescriptor {
  return {
    provider: 'openrouter',
    kind: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-key-never-sent',
    billingMode: 'none',
    markup: 0,
    appName: 'Kortix',
    appReferer: 'https://kortix-computer-app.netlify.app',
    resolvedModel: model,
    fallbackModels: fallbacks,
    publicProvider: 'kortix',
    pricing: { inputPerMillion: 0, outputPerMillion: 0 },
  };
}

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

test('hard zero-cost guard allows only :free models and openrouter/free', () => {
  for (const ok of FREE_CHAIN) {
    assert.equal(isAllowedFreeOpenRouterModelId(ok), true);
    assert.equal(assertFreeOpenRouterModelId(ok), ok);
  }
  for (const paid of [
    'openai/gpt-4o',
    'anthropic/claude-3.5-sonnet',
    'google/gemini-2.5-pro',
    'google/gemma-4-31b-it',
    'openrouter/auto',
    '',
  ]) {
    assert.equal(isAllowedFreeOpenRouterModelId(paid), false);
    assert.throws(() => assertFreeOpenRouterModelId(paid), UpstreamMisconfiguredError);
  }
});

test('callUpstream refuses paid primary or paid fallback BEFORE any fetch call', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 200 });
  };

  await assert.rejects(
    () =>
      callUpstream(
        { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        makeDescriptor('openai/gpt-4o'),
        { fetchImpl },
      ),
    UpstreamMisconfiguredError,
  );

  await assert.rejects(
    () =>
      callUpstream(
        { model: FREE_CHAIN[0], messages: [{ role: 'user', content: 'hi' }] },
        makeDescriptor(FREE_CHAIN[0], [FREE_CHAIN[0], 'anthropic/claude-3.5-sonnet']),
        { fetchImpl },
      ),
    UpstreamMisconfiguredError,
  );

  assert.equal(fetchCalls, 0);
});

test('OpenRouter payload enforces max_tokens >= 4096, strips enable_thinking, caps native models <= 3', async () => {
  let capturedBody: any = null;
  let capturedHeaders: Record<string, string> = {};

  const fetchImpl = async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(String(init.body));
    capturedHeaders = (init.headers ?? {}) as Record<string, string>;
    return Response.json({
      id: 'gen-1',
      model: FREE_CHAIN[0],
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    });
  };

  const res = await callUpstream(
    {
      model: FREE_CHAIN[0],
      max_tokens: 1024,
      chat_template_kwargs: { enable_thinking: true },
      tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    },
    makeDescriptor(FREE_CHAIN[0], FREE_CHAIN),
    { fetchImpl },
  );

  assert.equal(res.status, 200);
  assert.ok(capturedBody);
  assert.equal(capturedBody.model, FREE_CHAIN[0]);
  assert.equal(capturedBody.route, 'fallback');
  assert.deepEqual(capturedBody.models, [FREE_CHAIN[0], FREE_CHAIN[1], FREE_CHAIN[2]]);
  assert.equal(capturedBody.models.length, 3);
  assert.equal(capturedBody.max_tokens, 4096);
  assert.equal(capturedBody.chat_template_kwargs, undefined);
  assert.equal(capturedBody.tool_choice, 'auto');
  assert.equal(capturedHeaders['x-title'], 'Kortix');
  assert.equal(capturedHeaders['http-referer'], 'https://kortix-computer-app.netlify.app');
});

test('dispatch fails over Primary (429) -> Fallback 1 (200 tool_call) with zero paid models called', async () => {
  const triedModels: string[] = [];

  const fetchImpl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { model: string; models?: string[] };
    assert.equal(isAllowedFreeOpenRouterModelId(body.model), true);
    for (const m of body.models ?? []) {
      assert.equal(isAllowedFreeOpenRouterModelId(m), true);
    }
    triedModels.push(body.model);

    if (body.model === FREE_CHAIN[0]) {
      return Response.json(
        { error: { code: 429, message: 'Rate limited upstream' } },
        { status: 429 },
      );
    }

    return Response.json({
      id: 'gen-2',
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"Google latest news"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
  };

  const resolveCandidates = async (model: string) => {
    const idx = FREE_CHAIN.indexOf(model as (typeof FREE_CHAIN)[number]);
    return [makeDescriptor(model, FREE_CHAIN.slice(Math.max(0, idx), Math.max(0, idx) + 3))];
  };

  const outcome = await dispatch(
    {
      model: FREE_CHAIN[0],
      stream: false,
      messages: [{ role: 'user', content: 'Search Google news' }],
    },
    {
      model: FREE_CHAIN[0],
      candidates: await resolveCandidates(FREE_CHAIN[0]),
      fallbackModels: FREE_CHAIN.slice(1),
      fallbackOn: 'any-error',
    },
    {
      requestId: 'req-failover-1',
      logger: silentLogger,
      fetchImpl,
      resolveCandidates,
      breakers: new CircuitBreakers(),
    },
  );

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.response?.status, 200);
  assert.equal(outcome.model, FREE_CHAIN[1]);
  assert.deepEqual(triedModels, [FREE_CHAIN[0], FREE_CHAIN[1]]);
});

test('dispatch fails over across 503, malformed tool JSON, empty response -> openrouter/free safety net', async () => {
  const triedModels: string[] = [];

  const fetchImpl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { model: string };
    assert.equal(isAllowedFreeOpenRouterModelId(body.model), true);
    triedModels.push(body.model);

    if (body.model === FREE_CHAIN[0]) {
      return new Response('upstream overloaded', { status: 503 });
    }
    if (body.model === FREE_CHAIN[1]) {
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{broken_json' } }],
            },
          },
        ],
      });
    }
    if (body.model === FREE_CHAIN[2]) {
      return Response.json({
        choices: [{ message: { role: 'assistant', content: '' } }],
      });
    }
    return Response.json({
      id: 'gen-safety',
      model: 'openrouter/free',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Recovered via openrouter/free' } }],
    });
  };

  const resolveCandidates = async (model: string) => [makeDescriptor(model, [model])];

  const outcome = await dispatch(
    { model: FREE_CHAIN[0], stream: false, messages: [{ role: 'user', content: 'hi' }] },
    {
      model: FREE_CHAIN[0],
      candidates: await resolveCandidates(FREE_CHAIN[0]),
      fallbackModels: FREE_CHAIN.slice(1),
      fallbackOn: 'any-error',
    },
    {
      requestId: 'req-failover-2',
      logger: silentLogger,
      fetchImpl,
      resolveCandidates,
      breakers: new CircuitBreakers(),
    },
  );

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.response?.status, 200);
  assert.equal(outcome.model, 'openrouter/free');
  assert.deepEqual(triedModels, [...FREE_CHAIN]);
});

test('dispatch fails over on empty SSE stream from Primary -> Fallback 1 streaming response', async () => {
  const triedModels: string[] = [];

  const fetchImpl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { model: string };
    assert.equal(isAllowedFreeOpenRouterModelId(body.model), true);
    triedModels.push(body.model);

    if (body.model === FREE_CHAIN[0]) {
      // Simulate an upstream SSE stream that sends only a comment and closes with no data frames.
      const emptyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': OPENROUTER PROCESSING\n\n'));
          controller.close();
        },
      });
      return new Response(emptyStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    const okStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ id: 'chunk-1', model: body.model, choices: [{ delta: { content: 'Hello' } }] })}\n\ndata: [DONE]\n\n`,
          ),
        );
        controller.close();
      },
    });
    return new Response(okStream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  const resolveCandidates = async (model: string) => [makeDescriptor(model, [model])];

  const outcome = await dispatch(
    { model: FREE_CHAIN[0], stream: true, messages: [{ role: 'user', content: 'hi' }] },
    {
      model: FREE_CHAIN[0],
      candidates: await resolveCandidates(FREE_CHAIN[0]),
      fallbackModels: FREE_CHAIN.slice(1),
      fallbackOn: 'any-error',
    },
    {
      requestId: 'req-failover-stream',
      logger: silentLogger,
      fetchImpl,
      resolveCandidates,
      breakers: new CircuitBreakers(),
    },
  );

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.response?.status, 200);
  assert.equal(outcome.model, FREE_CHAIN[1]);
  assert.deepEqual(triedModels, [FREE_CHAIN[0], FREE_CHAIN[1]]);
});

test('OpenRouter circuit breaker opens on 1st 404/429, skips Primary during cooldown, and recovers on half-open probe', async () => {
  assert.equal(tripsOpenRouterBreaker(404), true);
  assert.equal(tripsOpenRouterBreaker(429), true);
  assert.equal(tripsOpenRouterBreaker(504), true);
  assert.equal(tripsOpenRouterBreaker(400), false);
  // Default openRouterFreeBreakers config: 1st failure opens circuit immediately
  assert.equal(openRouterFreeBreakers instanceof CircuitBreakers, true);

  let fakeNow = 1_000_000;
  const breakers = new CircuitBreakers({
    consecutiveFailures: 1,
    failureRatio: 0.5,
    minRequests: 2,
    windowMs: 60_000,
    cooldownMs: 5 * 60_000,
    maxCooldownMs: 10 * 60_000,
    now: () => fakeNow,
  });

  let primaryHealthy = false;
  const callsPerRequest: string[][] = [];

  const fetchImpl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { model: string };
    callsPerRequest[callsPerRequest.length - 1]!.push(body.model);
    if (body.model === FREE_CHAIN[0] && !primaryHealthy) {
      return Response.json(
        { error: { code: 404, message: 'No endpoints found for rotated free model' } },
        { status: 404 },
      );
    }
    return Response.json({
      id: `ok-${body.model}`,
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: `served by ${body.model}` } }],
    });
  };

  const resolveCandidates = async (model: string) => [makeDescriptor(model, [model])];
  const runOne = async (reqId: string) => {
    callsPerRequest.push([]);
    return dispatch(
      { model: FREE_CHAIN[0], stream: false, messages: [{ role: 'user', content: 'ping' }] },
      {
        model: FREE_CHAIN[0],
        candidates: await resolveCandidates(FREE_CHAIN[0]),
        fallbackModels: FREE_CHAIN.slice(1),
        fallbackOn: 'any-error',
      },
      {
        requestId: reqId,
        logger: silentLogger,
        fetchImpl,
        resolveCandidates,
        breakers,
      },
    );
  };

  // Request 1: Primary returns 404 -> trips breaker on 1st failure & fails over to Fallback 1 immediately.
  const r1 = await runOne('cb-req-1');
  assert.equal(r1.response?.status, 200);
  assert.equal(r1.model, FREE_CHAIN[1]);
  assert.deepEqual(callsPerRequest[0], [FREE_CHAIN[0], FREE_CHAIN[1]]);
  assert.equal(breakers.snapshot().length, 1);

  // Request 2 (+30s, inside 5-min cooldown): Primary is skipped cleanly (0 calls to Primary!).
  fakeNow += 30_000;
  const r2 = await runOne('cb-req-2');
  assert.equal(r2.response?.status, 200);
  assert.equal(r2.model, FREE_CHAIN[1]);
  assert.deepEqual(callsPerRequest[1], [FREE_CHAIN[1]]);
  assert.ok(r2.candidatesTried.some((entry) => entry.includes('circuit_open')));

  // Request 3 (+5m): Half-open probe sees Primary healthy -> closes circuit & serves on Primary again.
  fakeNow += 5 * 60_000;
  primaryHealthy = true;
  const r3 = await runOne('cb-req-3');
  assert.equal(r3.response?.status, 200);
  assert.equal(r3.model, FREE_CHAIN[0]);
  assert.deepEqual(callsPerRequest[2], [FREE_CHAIN[0]]);
  assert.equal(breakers.snapshot().length, 0);
});

test('openDirectStream throws UpstreamHttpError(504) when failOnTimeout deadline expires before first data frame', async () => {
  const hungStream = new ReadableStream<Uint8Array>({
    start() {
      // Never enqueues a data frame
    },
  });
  const response = new Response(hungStream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  await assert.rejects(
    () => openDirectStream(response, 'openrouter', { commitAfterMs: 40, failOnTimeout: true }),
    (err: any) => err?.name === 'UpstreamHttpError' && err?.status === 504,
  );
});
