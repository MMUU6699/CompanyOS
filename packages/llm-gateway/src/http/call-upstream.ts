import { resolvePinnedEgress, UnsafeEgressError } from '@kortix/shared/ssrf-guard';
import type { UpstreamDescriptor } from '../domain';
import { ClientAbortError, UpstreamHttpError, UpstreamMisconfiguredError } from '../errors';
import type { AiSdkFetch } from '../transports/ai-sdk';
import { resolveTransportKind } from '../transports/route-kind';
import {
  exposeGeminiThoughtSignaturesInResponse,
  isGoogleOpenAiUpstream,
  restoreGeminiThoughtSignatures,
} from './gemini-thought-signatures';
// The SHARED implementation. This module carried its own copy using
// `value.replace(/\/+$/, '')`, which CodeQL flags as `js/polynomial-redos`
// (high, alert #5907): on a long run of slashes that is not at the end, the
// engine retries the quantifier from every start position. The copy in
// transports/ai-sdk/model.ts was rewritten to a linear charCodeAt loop for
// alert #4731; this one was missed because the logic was duplicated. Importing
// it means there is one implementation to keep correct.
import { trimTrailingSlash } from '../transports/ai-sdk/model';

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface CallUpstreamOptions {
  fetchImpl?: FetchImpl;
  /** Inbound client's abort signal — combined with the per-attempt timeout
   *  signal so a caller disconnect aborts the in-flight upstream fetch too,
   *  instead of only bounding it by the retry timeout. */
  signal?: AbortSignal;
  // Kortix-internal correlation id for this request (see pipeline/simple-handler.ts's
  // requestId()). Sent to the upstream as a best-effort header so a failed
  // or slow completion can be cross-referenced against the provider's own
  // request logs/support tooling — every provider here tolerates unknown
  // headers, so this is safe to always send rather than gated per-transport.
  requestId?: string;
}

// The AI SDK provider packages build their outgoing request straight from
// `descriptor.baseUrl` — a required `string` on the type, but TypeScript
// can't stop that string from being empty or unparseable at runtime. Left
// unchecked, a blank baseUrl reaches deep inside a provider SDK/fetch call
// before failing with an opaque "Invalid URL" — and for the STREAMING path
// specifically, that failure never even throws: it surfaces as a 200-status
// SSE stream carrying an in-band `error` frame (see UpstreamMisconfiguredError's
// doc comment in errors.ts). Every descriptor this gateway resolves today
// (apps/api's resolveCandidates, which is provider-keyed — see
// provider-registry.ts's resolveCatalogUpstream — never per-model) already
// carries a real baseUrl, so this never fires in practice; it exists purely
// as a fail-fast, correctly-classified backstop against a FUTURE resolution
// regression (a different host's resolveUpstream hook, a new provider kind,
// ...) instead of letting a bad descriptor reach the transport at all.
function assertUsableBaseUrl(descriptor: UpstreamDescriptor): void {
  const baseUrl = descriptor.baseUrl?.trim();
  if (!baseUrl) {
    throw new UpstreamMisconfiguredError(descriptor.provider || 'unknown', 'missing baseUrl');
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('not http(s)');
    }
  } catch {
    throw new UpstreamMisconfiguredError(
      descriptor.provider || 'unknown',
      `invalid baseUrl "${descriptor.baseUrl}"`,
    );
  }
}

// Adapts `FetchImpl` (this package's own, `(input: string, init: RequestInit)`)
// to the AI SDK provider packages' `fetch` override (`typeof globalThis.fetch`,
// `input?: RequestInfo | URL`, `init?: RequestInit`) so a caller-supplied
// fetchImpl (production middleware, or a test double — see CallUpstreamOptions)
// is honored on the ai-sdk engine exactly like it was on the retired native
// transport's direct `fetch()` call.
function toAiSdkFetch(fetchImpl: FetchImpl): AiSdkFetch {
  return (input, init) => fetchImpl(String(input), init ?? {});
}

/** The JSON request headers of a direct (bearer-key) call to `descriptor`. */
export function upstreamHeaders(descriptor: UpstreamDescriptor, requestId?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!descriptor.omitAuthorization) headers.authorization = `Bearer ${descriptor.apiKey}`;
  if (descriptor.appName) headers['x-title'] = descriptor.appName;
  if (descriptor.appReferer) headers['http-referer'] = descriptor.appReferer;
  if (descriptor.headers) Object.assign(headers, descriptor.headers);
  if (requestId) headers['x-request-id'] = requestId;
  return headers;
}

const OPENROUTER_HOST = 'openrouter.ai';
const OPENROUTER_FREE_ROUTER = 'openrouter/free';
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_MIN_OUTPUT_TOKENS = 4096;
const OPENROUTER_MAX_OUTPUT_TOKENS = 16384;
const OPENROUTER_NATIVE_MODELS_MAX = 3;

export const ALLOWED_FREE_NVIDIA_MODELS: ReadonlySet<string> = new Set([
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'stepfun-ai/step-5-preview',
  'minimaxai/minimax-m3.1-flash',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3-ultra-550b-a55b',
]);

export const VISION_CAPABLE_FREE_MODELS: ReadonlySet<string> = new Set([
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'stepfun-ai/step-5-preview',
  'minimaxai/minimax-m3.1-flash',
  'nvidia/nemotron-3.5-super-vl:free',
  'google/gemma-4-31b-it:free',
  OPENROUTER_FREE_ROUTER,
]);

/**
 * STRICT ZERO-COST GUARD: only OpenRouter `:free` models and the
 * `openrouter/free` free-only router may ever be sent to OpenRouter,
 * and only allowlisted free-tier NVIDIA NIM models may be sent to NVIDIA NIM.
 */
export function isAllowedFreeOpenRouterModelId(modelId: unknown): modelId is string {
  if (typeof modelId !== 'string') return false;
  const trimmed = modelId.trim();
  if (!trimmed) return false;
  return trimmed === OPENROUTER_FREE_ROUTER || trimmed.endsWith(':free');
}

export function isAllowedFreeNvidiaModelId(modelId: unknown): modelId is string {
  if (typeof modelId !== 'string') return false;
  const trimmed = modelId.trim();
  if (!trimmed) return false;
  return ALLOWED_FREE_NVIDIA_MODELS.has(trimmed);
}

export function isAllowedFreeModelId(modelId: unknown): modelId is string {
  return isAllowedFreeOpenRouterModelId(modelId) || isAllowedFreeNvidiaModelId(modelId);
}

export function isVisionCapableFreeModelId(modelId: unknown): boolean {
  if (typeof modelId !== 'string') return false;
  return VISION_CAPABLE_FREE_MODELS.has(modelId.trim());
}

export function assertFreeOpenRouterModelId(modelId: unknown, context = 'model'): string {
  if (!isAllowedFreeOpenRouterModelId(modelId)) {
    throw new UpstreamMisconfiguredError(
      'openrouter',
      `Refused non-free OpenRouter ${context} "${String(modelId ?? '')}": only ":free" models or "openrouter/free" are permitted.`,
    );
  }
  return modelId.trim();
}

export function assertFreeNvidiaModelId(modelId: unknown, context = 'model'): string {
  if (!isAllowedFreeNvidiaModelId(modelId)) {
    throw new UpstreamMisconfiguredError(
      'nvidia',
      `Refused non-allowlisted NVIDIA NIM ${context} "${String(modelId ?? '')}": only verified free-tier NVIDIA NIM models are permitted.`,
    );
  }
  return modelId.trim();
}

export function assertFreeModelId(modelId: unknown, context = 'model'): string {
  if (!isAllowedFreeModelId(modelId)) {
    throw new UpstreamMisconfiguredError(
      'kortix',
      `Refused non-free ${context} "${String(modelId ?? '')}": only OpenRouter ":free" / "openrouter/free" or allowlisted free NVIDIA NIM models are permitted.`,
    );
  }
  return modelId.trim();
}

function isOpenRouterDescriptor(descriptor: UpstreamDescriptor): boolean {
  if (descriptor.provider === 'openrouter') return true;
  try {
    const host = new URL(descriptor.baseUrl).hostname.toLowerCase();
    return host === OPENROUTER_HOST || host.endsWith(`.${OPENROUTER_HOST}`);
  } catch {
    return false;
  }
}

function buildOpenRouterFreePayload(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
): Record<string, unknown> {
  const {
    max_completion_tokens: maxCompletionTokens,
    chat_template_kwargs: _droppedTemplateKwargs,
    enable_thinking: _droppedThinking,
    ...rest
  } = body;

  const primaryModel = assertFreeOpenRouterModelId(
    descriptor.resolvedModel || rest.model,
    'primary model',
  );

  // Validate every single native fallback candidate and cap at OpenRouter's
  // hard 3-model limit for the `models` array.
  const rawFallbacks = [primaryModel, ...(descriptor.fallbackModels ?? [])];
  const uniqueFreeModels: string[] = [];
  for (const candidate of rawFallbacks) {
    const safeId = assertFreeOpenRouterModelId(candidate, 'fallback model');
    if (!uniqueFreeModels.includes(safeId)) {
      uniqueFreeModels.push(safeId);
    }
    if (uniqueFreeModels.length >= OPENROUTER_NATIVE_MODELS_MAX) break;
  }

  const requestedMaxTokens =
    typeof rest.max_tokens === 'number' && Number.isFinite(rest.max_tokens) && rest.max_tokens > 0
      ? Math.floor(rest.max_tokens)
      : typeof maxCompletionTokens === 'number' && Number.isFinite(maxCompletionTokens) && maxCompletionTokens > 0
        ? Math.floor(maxCompletionTokens)
        : OPENROUTER_DEFAULT_MAX_TOKENS;

  const maxTokens = Math.min(
    OPENROUTER_MAX_OUTPUT_TOKENS,
    Math.max(requestedMaxTokens, OPENROUTER_MIN_OUTPUT_TOKENS),
  );

  const payload: Record<string, unknown> = {
    ...rest,
    model: primaryModel,
    max_tokens: maxTokens,
    stream: Boolean(rest.stream),
  };

  if (uniqueFreeModels.length > 1) {
    payload.models = uniqueFreeModels;
    payload.route = 'fallback';
  } else {
    delete payload.models;
    delete payload.route;
  }

  return payload;
}

/**
 * Validates a non-streaming HTTP 200 OpenRouter JSON response before returning
 * it to the client. Embedded error objects, empty assistant outputs, or
 * malformed tool-call argument JSON trigger an `UpstreamHttpError(502)` so
 * `dispatch()` automatically fails over to the next `:free` model.
 */
async function validateNonStreamingFreeResponse(
  response: Response,
  providerName = 'openrouter',
): Promise<Response> {
  if (!response.ok) return response;
  const raw = await response.text();
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(raw) as Record<string, any>;
  } catch {
    throw new UpstreamHttpError(502, `Invalid JSON response from ${providerName}: ${raw.slice(0, 200)}`, providerName);
  }
  if (parsed?.error && typeof parsed.error === 'object') {
    const code = Number((parsed.error as { code?: unknown }).code);
    throw new UpstreamHttpError(
      code >= 400 && code <= 599 ? code : 502,
      raw.slice(0, 500),
      providerName,
    );
  }
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
  const msg = choice?.message;
  const hasContent = typeof msg?.content === 'string' && msg.content.trim().length > 0;
  const hasReasoning =
    (typeof msg?.reasoning === 'string' && msg.reasoning.trim().length > 0) ||
    (typeof msg?.reasoning_content === 'string' && msg.reasoning_content.trim().length > 0);
  const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  if (!hasContent && !hasReasoning && toolCalls.length === 0) {
    throw new UpstreamHttpError(502, `Empty assistant response from ${providerName} free model`, providerName);
  }
  for (const tc of toolCalls) {
    const args = tc?.function?.arguments;
    if (typeof args === 'string' && args.trim().length > 0) {
      try {
        JSON.parse(args);
      } catch {
        throw new UpstreamHttpError(
          502,
          `Malformed tool_call JSON from ${providerName} free model (${tc?.function?.name ?? 'unknown'})`,
          providerName,
        );
      }
    }
  }
  return new Response(raw, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

const NVIDIA_NIM_HOST = 'integrate.api.nvidia.com';
const NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const NVIDIA_DEFAULT_MAX_TOKENS = 8192;
const NVIDIA_MIN_OUTPUT_TOKENS = 4096;
const NVIDIA_MAX_OUTPUT_TOKENS = 8192;

function isNvidiaNimDescriptor(descriptor: UpstreamDescriptor): boolean {
  if (descriptor.provider === 'nvidia') return true;
  try {
    return new URL(descriptor.baseUrl).hostname === NVIDIA_NIM_HOST;
  } catch {
    return false;
  }
}

function buildNvidiaNimPayload(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
): Record<string, unknown> {
  const {
    max_completion_tokens: maxCompletionTokens,
    chat_template_kwargs: existingTemplateKwargs,
    reasoning_effort: _ignoredEffort,
    ...rest
  } = body;
  const targetModel = assertFreeNvidiaModelId(
    descriptor.resolvedModel || rest.model || NVIDIA_DEFAULT_MODEL,
    'NVIDIA NIM model',
  );
  const requestedMaxTokens =
    typeof rest.max_tokens === 'number' && Number.isFinite(rest.max_tokens) && rest.max_tokens > 0
      ? Math.floor(rest.max_tokens)
      : typeof maxCompletionTokens === 'number' && Number.isFinite(maxCompletionTokens) && maxCompletionTokens > 0
        ? Math.floor(maxCompletionTokens)
        : NVIDIA_DEFAULT_MAX_TOKENS;
  const maxTokens = Math.min(
    NVIDIA_MAX_OUTPUT_TOKENS,
    Math.max(requestedMaxTokens, NVIDIA_MIN_OUTPUT_TOKENS),
  );
  // Keep enable_thinking: false by default so tool calls and chat responses
  // stream in < 1s without stalling in 32k-token hidden reasoning loops.
  const explicitThinking =
    existingTemplateKwargs &&
    typeof existingTemplateKwargs === 'object' &&
    !Array.isArray(existingTemplateKwargs) &&
    typeof (existingTemplateKwargs as Record<string, unknown>).enable_thinking === 'boolean'
      ? Boolean((existingTemplateKwargs as Record<string, unknown>).enable_thinking)
      : false;
  const templateKwargs =
    existingTemplateKwargs && typeof existingTemplateKwargs === 'object' && !Array.isArray(existingTemplateKwargs)
      ? { ...(existingTemplateKwargs as Record<string, unknown>), enable_thinking: explicitThinking }
      : { enable_thinking: false };

  return {
    ...rest,
    model: targetModel,
    max_tokens: maxTokens,
    stream: Boolean(rest.stream),
    temperature: typeof rest.temperature === 'number' ? rest.temperature : 0.2,
    top_p: typeof rest.top_p === 'number' ? rest.top_p : 0.95,
    chat_template_kwargs: templateKwargs,
  };
}

async function directOpenAiRequest(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
  opts: CallUpstreamOptions,
): Promise<Response> {
  const headers = upstreamHeaders(descriptor, opts.requestId);
  const isOpenRouter = isOpenRouterDescriptor(descriptor);
  const isNvidia = !isOpenRouter && isNvidiaNimDescriptor(descriptor);
  if (isNvidia || isOpenRouter) {
    headers.accept = body.stream ? 'text/event-stream' : 'application/json';
  }

  const payload = isOpenRouter
    ? buildOpenRouterFreePayload(body, descriptor)
    : isNvidia
      ? buildNvidiaNimPayload(body, descriptor)
      : descriptor.resolvedModel
        ? { ...body, model: descriptor.resolvedModel }
        : body;

  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const url = `${trimTrailingSlash(descriptor.baseUrl)}/chat/completions`;
  const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(payload), signal: opts.signal };
  if (!descriptor.egress) return fetchImpl(url, init);
  let pinned: Awaited<ReturnType<typeof resolvePinnedEgress>>;
  try {
    pinned = await resolvePinnedEgress(url, { allowHttp: true, allowPrivateHosts: descriptor.egress.allowPrivateHosts });
  } catch (error) {
    if (!(error instanceof UnsafeEgressError)) throw error;
    throw new UpstreamMisconfiguredError(descriptor.provider, `the base URL is not reachable from the gateway (${error.message})`);
  }
  if (pinned.host) headers.host = pinned.host;
  return fetchImpl(pinned.url, {
    ...init,
    redirect: 'manual',
    ...(pinned.serverName ? { tls: { serverName: pinned.serverName } } : {}),
  } as RequestInit);
}

/**
 * How long a direct stream may send only SSE comments before the gateway
 * answers the client anyway. OpenRouter answers 200 at once, sends
 * `: OPENROUTER PROCESSING` through a prefill, and reports an endpoint's
 * rejection as the first `data:` frame (a context overflow arrived within about
 * 1 s of the headers on 2026-09-30). The client's headers wait at most this
 * long; the Cloudflare response deadline in front of the API is 100 s.
 */
export const DIRECT_STREAM_COMMIT_MS = 10_000;
export const OPENROUTER_STREAM_FIRST_TOKEN_TIMEOUT_MS =
  Number(process.env.OPENROUTER_FIRST_TOKEN_TIMEOUT_MS) || 15_000;

// Comment bytes read without a `data:` frame before the stream is committed anyway.
const DIRECT_STREAM_PEEK_MAX_CHARS = 64 * 1024;

/**
 * Reads a streamed direct response up to its first `data:` frame, for at most
 * `commitAfterMs`. An error frame there served nothing, so it throws the
 * `UpstreamHttpError` a non-2xx answer throws: dispatch fails over, and the
 * client gets an HTTP error. When `failOnTimeout` is true (used for
 * OpenRouter `:free` streams), exceeding `commitAfterMs` without receiving any
 * `data:` frame aborts the upstream stream and throws `UpstreamHttpError(504)`
 * so `dispatch()` trips the circuit breaker and fails over immediately.
 */
export async function openDirectStream(
  response: Response,
  provider: string,
  {
    commitAfterMs = DIRECT_STREAM_COMMIT_MS,
    failOnTimeout = false,
    signal,
  }: { commitAfterMs?: number; failOnTimeout?: boolean; signal?: AbortSignal } = {},
): Promise<Response> {
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const read: Uint8Array[] = [];
  let text = '';
  let inFlight: ReturnType<typeof reader.read> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const commit = new Promise<'commit' | 'timeout'>((resolve) => {
    timer = setTimeout(
      () => {
        timedOut = failOnTimeout && !signal?.aborted;
        resolve(timedOut ? 'timeout' : 'commit');
      },
      signal?.aborted ? 0 : commitAfterMs,
    );
    signal?.addEventListener('abort', () => resolve('commit'), { once: true });
  });
  let sawDataFrame = false;
  try {
    while (text.length <= DIRECT_STREAM_PEEK_MAX_CHARS) {
      const reading = reader.read();
      inFlight = reading;
      const next = await Promise.race([reading, commit]);
      if (next === 'timeout') {
        reading.catch(() => {});
        await reader.cancel().catch(() => {});
        throw new UpstreamHttpError(504, 'OpenRouter stream first-token timeout', provider);
      }
      if (next === 'commit') {
        // The replay below hands this read to the relay, which handles its result.
        reading.catch(() => {});
        break;
      }
      inFlight = null;
      if (next.done) {
        if (!sawDataFrame) {
          throw new UpstreamHttpError(502, 'Upstream stream ended with no data frames', provider);
        }
        break;
      }
      read.push(next.value);
      text += decoder.decode(next.value, { stream: true });
      const complete = text.slice(0, text.lastIndexOf('\n') + 1);
      const dataLines = complete.split('\n').filter((l) => l.startsWith('data:'));
      if (dataLines.length === 0) continue;
      let sawNonDone = false;
      for (const line of dataLines) {
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let error: { code?: unknown } | undefined;
        try {
          error = (JSON.parse(payload) as { error?: { code?: unknown } }).error;
        } catch {
          // Non-JSON frame: not an error frame.
        }
        if (error && typeof error === 'object') {
          await reader.cancel().catch(() => {});
          const code = Number(error.code);
          throw new UpstreamHttpError(code >= 400 && code <= 599 ? code : 502, payload, provider);
        }
        sawNonDone = true;
      }
      if (sawNonDone) {
        sawDataFrame = true;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = read.shift();
        if (chunk) return controller.enqueue(chunk);
        const next = await (inFlight ?? reader.read());
        inFlight = null;
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}

export async function callUpstream(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
  opts: CallUpstreamOptions = {},
): Promise<Response> {
  assertUsableBaseUrl(descriptor);

  const clientSignal = opts.signal;
  // A caller already gone before dispatch even starts must never spend a
  // fetch/retry/breaker-trip on a response no one will receive.
  if (clientSignal?.aborted) throw new ClientAbortError();

  const transportKind = resolveTransportKind(body, descriptor);
  if (transportKind === 'openai-compat' || transportKind === 'custom') {
    const streaming = body.stream === true;
    // Gemini thought signatures travel in `extra_content`, which pi drops
    // (see gemini-thought-signatures.ts).
    const google = isGoogleOpenAiUpstream(descriptor);
    const sent = google ? restoreGeminiThoughtSignatures(body, descriptor.resolvedModel) : body;
    const response = await directOpenAiRequest(sent, descriptor, opts);
    const isOpenRouter = isOpenRouterDescriptor(descriptor);
    const isNvidia = !isOpenRouter && isNvidiaNimDescriptor(descriptor);
    const isManagedFree = isOpenRouter || isNvidia;
    const opened = streaming
      ? await openDirectStream(response, descriptor.provider, {
          signal: clientSignal,
          ...(isManagedFree
            ? { commitAfterMs: OPENROUTER_STREAM_FIRST_TOKEN_TIMEOUT_MS, failOnTimeout: true }
            : {}),
        })
      : isManagedFree
        ? await validateNonStreamingFreeResponse(response, descriptor.provider)
        : response;
    return google ? exposeGeminiThoughtSignaturesInResponse(opened, streaming) : opened;
  }

  const fetchImpl: AiSdkFetch | undefined = opts.fetchImpl
    ? toAiSdkFetch(opts.fetchImpl)
    : undefined;

  try {
    const { callUpstreamViaAiSdk } = await import('../transports/ai-sdk');
    return await callUpstreamViaAiSdk(body, descriptor, {
      signal: clientSignal,
      fetch: fetchImpl,
      requestId: opts.requestId,
    });
  } catch (err) {
    if (clientSignal?.aborted) throw new ClientAbortError();
    throw err;
  }
}
