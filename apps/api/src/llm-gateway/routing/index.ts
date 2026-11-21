import type { ModelRouteInput, ModelRoutePlan, AuthedPrincipal } from '@kortix/llm-gateway';
import {
  openRouterFreeChain,
  openRouterFreeChainForRequest,
  refreshOpenRouterFreeChainIfStale,
} from '../resolution/openrouter-free';

/**
 * 100% FREE-ONLY Unified Multi-Provider (NVIDIA NIM + OpenRouter `:free`) fallback routing.
 * - Vision requests (`input.requires.imageInput === true`) route strictly across Vision-capable free models.
 * - Text & Tool-Calling requests route across all 9 free tiers (`openrouter/free` final safety net).
 * Rotates automatically on 404, 429, 5xx, 15s timeout, empty streams, or malformed tool calls.
 */
export async function resolveGatewayRoute(
  _principal: AuthedPrincipal,
  input: ModelRouteInput,
): Promise<ModelRoutePlan> {
  const requiresVision = Boolean(input?.requires?.imageInput);
  await refreshOpenRouterFreeChainIfStale().catch(() => openRouterFreeChain());
  const chain = openRouterFreeChainForRequest({ requiresVision });
  return {
    policyId: requiresVision ? 'free-vision-chain' : 'openrouter-free-chain',
    primaryModel: chain[0]!,
    fallbackModels: [...chain.slice(1)],
    fallbackOn: 'any-error',
  };
}
