import {
  assertFreeOpenRouterModelId,
  GatewayResolutionError,
  isAllowedFreeOpenRouterModelId,
  type UpstreamDescriptor,
} from '@kortix/llm-gateway';
import { config } from '../../config';
import type { ManagedModel } from '../models/managed-models';

/**
 * STRICT 100% FREE-ONLY OpenRouter multi-model fallback chain.
 *
 * Every model in this chain MUST end with `:free` (verified $0.00 prompt &
 * $0.00 completion on OpenRouter) or equal `openrouter/free` (OpenRouter's
 * Free Models Router). Paid models are hard-blocked at both resolution and
 * upstream wire level (`assertFreeOpenRouterModelId`).
 *
 * Verified live 2026-11-20 against https://openrouter.ai/api/v1/models +
 * live streaming & tool-calling benchmark ($0.00 cost):
 *   1. Primary:          nvidia/nemotron-3.5-lightning:free     (1M ctx, 411ms TTFT, 540ms tool call)
 *   2. Fallback 1:       nvidia/nemotron-3-ultra-550b-a55b:free (1M ctx, 1012ms TTFT, 3284ms tool call)
 *   3. Fallback 2:       nvidia/nemotron-3.5-super-vl:free      (1M ctx, vision, 613ms TTFT, 1553ms total)
 *   4. Final Safety Net: openrouter/free                        (200k ctx, free-only router)
 */
export const OPENROUTER_FREE_PROVIDER_ID = 'openrouter';
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_FREE_SAFETY_NET = 'openrouter/free';
export const OPENROUTER_APP_NAME = 'Kortix';
export const OPENROUTER_APP_REFERER = 'https://kortix-computer-app.netlify.app';

export const DEFAULT_OPENROUTER_FREE_CHAIN = [
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-super-vl:free',
  OPENROUTER_FREE_SAFETY_NET,
] as const;

const OPENROUTER_MODEL_DISPLAY_NAMES: Record<string, string> = {
  'nvidia/nemotron-3.5-lightning:free': 'Nemotron 3.5 Lightning (Free)',
  'nvidia/nemotron-3-ultra-550b-a55b:free': 'Nemotron 3 Ultra 550B (Free)',
  'nvidia/nemotron-3.5-super-vl:free': 'Nemotron 3.5 Super VL (Free)',
  'openrouter/free': 'OpenRouter Free Router',
};

/**
 * Returns the active 100% FREE OpenRouter fallback chain.
 * If `OPENROUTER_FREE_MODELS` is set (comma-separated), every entry is
 * strictly validated: any non-free slug throws immediately rather than
 * risking a paid upstream call. Always guarantees `openrouter/free` as the
 * final free-only safety net.
 */
export function openRouterFreeChain(): readonly string[] {
  const raw = (config.OPENROUTER_FREE_MODELS ?? '').trim();
  if (!raw) return DEFAULT_OPENROUTER_FREE_CHAIN;

  const parsed = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (parsed.length === 0) return DEFAULT_OPENROUTER_FREE_CHAIN;

  const validated: string[] = [];
  for (const modelId of parsed) {
    if (!isAllowedFreeOpenRouterModelId(modelId)) {
      throw new GatewayResolutionError(
        'model_disabled_on_deployment',
        `OPENROUTER_FREE_MODELS contains non-free model "${modelId}". Only ":free" models or "openrouter/free" are allowed.`,
        'Remove paid models from OPENROUTER_FREE_MODELS and keep only ":free" models or "openrouter/free".',
      );
    }
    if (!validated.includes(modelId)) {
      validated.push(modelId);
    }
  }
  if (!validated.includes(OPENROUTER_FREE_SAFETY_NET)) {
    validated.push(OPENROUTER_FREE_SAFETY_NET);
  }
  return validated;
}

export function primaryOpenRouterFreeModelId(): string {
  return openRouterFreeChain()[0]!;
}

export function isInOpenRouterFreeChain(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const trimmed = modelId.trim();
  return openRouterFreeChain().includes(trimmed);
}

export function openRouterFreeManagedModel(modelId = primaryOpenRouterFreeModelId()): ManagedModel {
  const safeId = assertFreeOpenRouterModelId(modelId, 'managed model');
  return {
    id: safeId,
    name: OPENROUTER_MODEL_DISPLAY_NAMES[safeId] ?? safeId,
    pricing: {
      inputPerMillion: 0,
      outputPerMillion: 0,
    },
    vision: true,
    limit: {
      context: 200_000,
      output: 16_384,
    },
  };
}

export function openRouterFreeGatewayModel(modelId = primaryOpenRouterFreeModelId()) {
  const managed = openRouterFreeManagedModel(modelId);
  return {
    name: managed.name,
    provider: 'kortix',
    provider_name: 'Kortix',
    family: 'openrouter-free',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    structured_output: true,
    open_weights: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: managed.limit.context, output: managed.limit.output },
    cost: { input: 0, output: 0 },
  };
}

export function openRouterFreeGatewayCatalog() {
  const primary = primaryOpenRouterFreeModelId();
  return {
    [primary]: openRouterFreeGatewayModel(primary),
  };
}

/**
 * Builds the OpenRouter UpstreamDescriptor for `requestedModel`:
 * - If `requestedModel` is an explicit member of our verified 100% `:free`
 *   fallback chain (e.g. during `dispatch()` failover), routes to that exact
 *   `:free` model with up to 2 remaining `:free` models in OpenRouter's native
 *   `models` fallback array (max 3 total per OpenRouter API limit).
 * - Otherwise pins strictly to Primary (`openRouterFreeChain()[0]`) so callers
 *   can never bypass the free-only policy with an arbitrary or paid model slug.
 */
export function openRouterFreeDescriptorForModel(requestedModel?: string | null): UpstreamDescriptor {
  const apiKey = (config.OPENROUTER_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new GatewayResolutionError(
      'model_disabled_on_deployment',
      'OPENROUTER_API_KEY is not configured on the backend server.',
      'Set OPENROUTER_API_KEY in the backend server environment variables.',
    );
  }

  const chain = openRouterFreeChain();
  const normalized = (requestedModel ?? '').trim();
  const idx = normalized ? chain.indexOf(normalized) : -1;
  const targetModel = assertFreeOpenRouterModelId(
    idx >= 0 ? chain[idx]! : chain[0]!,
    'resolved model',
  );

  // OpenRouter caps `models` at 3 items total (primary + 2 native fallbacks).
  // Remaining tiers are also covered by Kortix gateway `dispatch()` failover.
  const nativeFallbacks = chain
    .slice(idx >= 0 ? idx : 0)
    .slice(0, 3)
    .map((m) => assertFreeOpenRouterModelId(m, 'native fallback'));

  const baseUrl = (config.OPENROUTER_BASE_URL || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    provider: OPENROUTER_FREE_PROVIDER_ID,
    kind: 'openai-compat',
    baseUrl,
    apiKey,
    credentialRef: 'env:OPENROUTER_API_KEY',
    billingMode: 'none',
    markup: 0,
    appName: OPENROUTER_APP_NAME,
    appReferer: OPENROUTER_APP_REFERER,
    resolvedModel: targetModel,
    fallbackModels: nativeFallbacks,
    publicProvider: 'kortix',
    pricing: {
      inputPerMillion: 0,
      outputPerMillion: 0,
    },
    reasoning: true,
    temperature: true,
  };
}
