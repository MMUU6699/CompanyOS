import { sql } from 'drizzle-orm';
import {
  assertFreeModelId,
  assertFreeNvidiaModelId,
  assertFreeOpenRouterModelId,
  GatewayResolutionError,
  isAllowedFreeModelId,
  isAllowedFreeNvidiaModelId,
  isAllowedFreeOpenRouterModelId,
  isVisionCapableFreeModelId,
  type UpstreamDescriptor,
} from '@kortix/llm-gateway';
import { config } from '../../config';
import { db, hasDatabase } from '../../shared/db';
import type { ManagedModel } from '../models/managed-models';

/**
 * STRICT 100% FREE-ONLY Unified Multi-Provider (NVIDIA NIM + OpenRouter `:free`)
 * fallback chain with Vision-aware routing.
 *
 * Every model in this chain is 100% free ($0.00 prompt & $0.00 completion):
 * - Free NVIDIA NIM models (verified live against https://integrate.api.nvidia.com/v1)
 * - Free OpenRouter models ending with `:free` or `openrouter/free`
 * Paid models are hard-blocked at both resolution and upstream wire level
 * (`assertFreeModelId`, `assertFreeNvidiaModelId`, `assertFreeOpenRouterModelId`).
 *
 * Verified live 2026-11-21 benchmark (Speed + OpenAI Tools + Vision `image_url`):
 *   1. nvidia/nemotron-3.5-super-vl-120b-a12b (NVIDIA NIM — Vision 1129ms, Tools 724ms, Stream TTFT 735ms)
 *   2. stepfun-ai/step-5-preview              (NVIDIA NIM — Vision 3353ms, Tools 1527ms, Stream TTFT 581ms)
 *   3. minimaxai/minimax-m3.1-flash           (NVIDIA NIM — Vision 7385ms, Tools 2290ms, Stream TTFT 808ms)
 *   4. nvidia/nemotron-3.5-lightning-30b-a3b  (NVIDIA NIM — Text + Tools 517ms, Stream TTFT 446ms)
 *   5. nvidia/nemotron-3-ultra-550b-a55b      (NVIDIA NIM — Text + Tools 1784ms, Stream TTFT 987ms)
 *   6. nvidia/nemotron-3.5-super-vl:free      (OpenRouter — Vision + Tools, 613ms TTFT)
 *   7. nvidia/nemotron-3.5-lightning:free     (OpenRouter — Text + Tools, 411ms TTFT)
 *   8. nvidia/nemotron-3-ultra-550b-a55b:free (OpenRouter — Text + Tools, 1012ms TTFT)
 *   9. openrouter/free                        (OpenRouter — Free Models Router safety net)
 */
export const OPENROUTER_FREE_PROVIDER_ID = 'openrouter';
export const NVIDIA_FREE_PROVIDER_ID = 'nvidia';
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const NVIDIA_DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const OPENROUTER_FREE_SAFETY_NET = 'openrouter/free';
export const OPENROUTER_APP_NAME = 'Kortix';
export const OPENROUTER_APP_REFERER = 'https://kortix-computer-app.netlify.app';

export const DEFAULT_OPENROUTER_FREE_CHAIN = [
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'stepfun-ai/step-5-preview',
  'minimaxai/minimax-m3.1-flash',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3.5-super-vl:free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  OPENROUTER_FREE_SAFETY_NET,
] as const;

const OPENROUTER_MODEL_DISPLAY_NAMES: Record<string, string> = {
  'nvidia/nemotron-3.5-super-vl-120b-a12b': 'Nemotron 3.5 Super VL 120B (Free)',
  'stepfun-ai/step-5-preview': 'Step 5 Preview VL (Free)',
  'minimaxai/minimax-m3.1-flash': 'MiniMax M3.1 Flash VL (Free)',
  'nvidia/nemotron-3.5-lightning-30b-a3b': 'Nemotron 3.5 Lightning 30B (Free)',
  'nvidia/nemotron-3-ultra-550b-a55b': 'Nemotron 3 Ultra 550B (Free)',
  'nvidia/nemotron-3.5-lightning:free': 'Nemotron 3.5 Lightning (Free)',
  'nvidia/nemotron-3-ultra-550b-a55b:free': 'Nemotron 3 Ultra 550B (Free)',
  'nvidia/nemotron-3.5-super-vl:free': 'Nemotron 3.5 Super VL (Free)',
  'openrouter/free': 'OpenRouter Free Router',
};

const CLOUD_CONFIG_KEY = 'openrouter_free_models';
const CLOUD_CACHE_TTL_MS = 30_000;

let cachedCloudChain: readonly string[] | null = null;
let cachedCloudChainExpiresAt = 0;
let cloudRefreshInFlight: Promise<readonly string[]> | null = null;

function parseRawModelEntries(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const decoded = JSON.parse(trimmed);
        if (Array.isArray(decoded)) {
          return decoded
            .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
            .filter(Boolean);
        }
      } catch {
        // Fall through to comma-separated parse.
      }
    }
    return trimmed
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function validateFreeChainOrThrow(entries: string[], sourceName: string): readonly string[] {
  const validated: string[] = [];
  for (const modelId of entries) {
    if (!isAllowedFreeModelId(modelId)) {
      throw new GatewayResolutionError(
        'model_disabled_on_deployment',
        `${sourceName} contains non-free model "${modelId}". Only allowlisted free NVIDIA NIM models, ":free" models, or "openrouter/free" are allowed.`,
        `Remove paid models from ${sourceName} and keep only free NVIDIA NIM models, ":free" models, or "openrouter/free".`,
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

function envOpenRouterFreeChain(): readonly string[] {
  const raw = (config.OPENROUTER_FREE_MODELS ?? '').trim();
  if (!raw) return DEFAULT_OPENROUTER_FREE_CHAIN;
  const parsed = parseRawModelEntries(raw);
  if (parsed.length === 0) return DEFAULT_OPENROUTER_FREE_CHAIN;
  return validateFreeChainOrThrow(parsed, 'OPENROUTER_FREE_MODELS');
}

/**
 * Refreshes the active free fallback chain from Supabase `kortix.runtime_config`
 * (`key = 'openrouter_free_models'`) with a 30s in-memory cache so cloud model
 * order/failover changes take effect immediately across Web + existing APKs with
 * zero rebuilds. Any non-free/paid entry in DB is rejected with a warning.
 */
export async function refreshOpenRouterFreeChainIfStale(): Promise<readonly string[]> {
  const now = Date.now();
  if (now < cachedCloudChainExpiresAt) {
    return openRouterFreeChain();
  }
  if (cloudRefreshInFlight) return cloudRefreshInFlight;

  cloudRefreshInFlight = (async (): Promise<readonly string[]> => {
    try {
      if (hasDatabase) {
        const rows = (await db.execute<{ value: unknown }>(
          sql`SELECT value FROM kortix.runtime_config WHERE key = ${CLOUD_CONFIG_KEY} LIMIT 1`,
        )) as Array<{ value: unknown }>;
        const entries = rows?.[0] ? parseRawModelEntries(rows[0].value) : [];
        if (entries.length > 0) {
          try {
            cachedCloudChain = validateFreeChainOrThrow(entries, `runtime_config.${CLOUD_CONFIG_KEY}`);
          } catch (err) {
            console.warn(
              '[openrouter-free] ignoring invalid cloud runtime_config override:',
              err instanceof Error ? err.message : String(err),
            );
            cachedCloudChain = null;
          }
        } else {
          cachedCloudChain = null;
        }
      }
    } catch (err) {
      // Missing table or transient DB error never blocks inference; keep env/default chain.
      console.warn(
        '[openrouter-free] runtime_config refresh failed (using env/default chain):',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      cachedCloudChainExpiresAt = Date.now() + CLOUD_CACHE_TTL_MS;
      cloudRefreshInFlight = null;
    }
    return openRouterFreeChain();
  })();

  return cloudRefreshInFlight;
}

/**
 * Returns the active 100% FREE multi-provider fallback chain (cloud override if
 * present & valid, else `OPENROUTER_FREE_MODELS` env var, else default chain).
 * If `NVIDIA_API_KEY` is not set, filters out NVIDIA-direct models automatically.
 * Paid models are always refused; `openrouter/free` is always appended last.
 */
export function openRouterFreeChain(): readonly string[] {
  const baseChain =
    cachedCloudChain && cachedCloudChain.length > 0 ? cachedCloudChain : envOpenRouterFreeChain();
  const hasNvidiaKey = Boolean((config.NVIDIA_API_KEY ?? '').trim());
  if (hasNvidiaKey) {
    return baseChain;
  }
  const openRouterOnly = baseChain.filter((m) => isAllowedFreeOpenRouterModelId(m));
  return openRouterOnly.length > 0 ? openRouterOnly : [OPENROUTER_FREE_SAFETY_NET];
}

/**
 * Vision-aware chain selector: when `requiresVision` is true (e.g. request contains
 * `image_url` / multimodal input), filters the active free chain down to Vision-capable
 * free models (`nvidia/nemotron-3.5-super-vl-120b-a12b`, `stepfun-ai/step-5-preview`,
 * `minimaxai/minimax-m3.1-flash`, `nvidia/nemotron-3.5-super-vl:free`, `openrouter/free`).
 */
export function openRouterFreeChainForRequest(opts?: { requiresVision?: boolean }): readonly string[] {
  const chain = openRouterFreeChain();
  if (!opts?.requiresVision) {
    return chain;
  }
  const visionChain = chain.filter((m) => isVisionCapableFreeModelId(m));
  return visionChain.length > 0 ? visionChain : [OPENROUTER_FREE_SAFETY_NET];
}

export function primaryOpenRouterFreeModelId(): string {
  return openRouterFreeChain()[0]!;
}

export function isInOpenRouterFreeChain(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const trimmed = modelId.trim();
  return openRouterFreeChain().includes(trimmed) || isAllowedFreeModelId(trimmed);
}

export function openRouterFreeManagedModel(modelId = primaryOpenRouterFreeModelId()): ManagedModel {
  const safeId = assertFreeModelId(modelId, 'managed model');
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
 * Builds the UpstreamDescriptor for `requestedModel` across NVIDIA NIM (free tier)
 * and OpenRouter (`:free` / `openrouter/free`):
 * - If `targetModel` is an allowlisted free NVIDIA NIM model and `NVIDIA_API_KEY`
 *   is configured, routes directly to `https://integrate.api.nvidia.com/v1` with
 *   low-latency `enable_thinking: false` and `$0.00` billing.
 * - Otherwise routes to OpenRouter `:free` with up to 2 remaining OpenRouter `:free`
 *   models in OpenRouter's native `models` fallback array (max 3 total).
 */
export function openRouterFreeDescriptorForModel(requestedModel?: string | null): UpstreamDescriptor {
  const chain = openRouterFreeChain();
  const normalized = (requestedModel ?? '').trim();
  const idx = normalized ? chain.indexOf(normalized) : -1;
  const targetModel = assertFreeModelId(
    idx >= 0 ? chain[idx]! : isAllowedFreeModelId(normalized) ? normalized : chain[0]!,
    'resolved model',
  );

  const nvidiaApiKey = (config.NVIDIA_API_KEY ?? '').trim();
  if (isAllowedFreeNvidiaModelId(targetModel) && nvidiaApiKey) {
    const safeNvidiaModel = assertFreeNvidiaModelId(targetModel, 'resolved nvidia model');
    const baseUrl = (config.NVIDIA_NIM_BASE_URL || NVIDIA_DEFAULT_BASE_URL).replace(/\/+$/, '');
    return {
      provider: NVIDIA_FREE_PROVIDER_ID,
      kind: 'openai-compat',
      baseUrl,
      apiKey: nvidiaApiKey,
      credentialRef: 'env:NVIDIA_API_KEY',
      billingMode: 'none',
      markup: 0,
      resolvedModel: safeNvidiaModel,
      publicProvider: 'kortix',
      pricing: {
        inputPerMillion: 0,
        outputPerMillion: 0,
      },
      reasoning: false,
      temperature: true,
    };
  }

  const openRouterApiKey = (config.OPENROUTER_API_KEY ?? '').trim();
  if (!openRouterApiKey) {
    throw new GatewayResolutionError(
      'model_disabled_on_deployment',
      'OPENROUTER_API_KEY is not configured on the backend server.',
      'Set OPENROUTER_API_KEY in the backend server environment variables.',
    );
  }

  const openRouterModelsInChain = chain.filter((m) => isAllowedFreeOpenRouterModelId(m));
  const openRouterTarget = isAllowedFreeOpenRouterModelId(targetModel)
    ? assertFreeOpenRouterModelId(targetModel, 'resolved openrouter model')
    : assertFreeOpenRouterModelId(openRouterModelsInChain[0] ?? OPENROUTER_FREE_SAFETY_NET, 'fallback openrouter model');

  const orIdx = openRouterModelsInChain.indexOf(openRouterTarget);
  const nativeFallbacks = openRouterModelsInChain
    .slice(orIdx >= 0 ? orIdx : 0)
    .slice(0, 3)
    .map((m) => assertFreeOpenRouterModelId(m, 'native fallback'));

  const baseUrl = (config.OPENROUTER_BASE_URL || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    provider: OPENROUTER_FREE_PROVIDER_ID,
    kind: 'openai-compat',
    baseUrl,
    apiKey: openRouterApiKey,
    credentialRef: 'env:OPENROUTER_API_KEY',
    billingMode: 'none',
    markup: 0,
    appName: OPENROUTER_APP_NAME,
    appReferer: OPENROUTER_APP_REFERER,
    resolvedModel: openRouterTarget,
    fallbackModels: nativeFallbacks.length > 0 ? nativeFallbacks : [openRouterTarget],
    publicProvider: 'kortix',
    pricing: {
      inputPerMillion: 0,
      outputPerMillion: 0,
    },
    reasoning: true,
    temperature: true,
  };
}
