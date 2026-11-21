import type { ModelRouteInput, ModelRoutePlan, AuthedPrincipal } from '@kortix/llm-gateway';
import {
  openRouterFreeChain,
  refreshOpenRouterFreeChainIfStale,
} from '../resolution/openrouter-free';

/**
 * 100% FREE-ONLY OpenRouter multi-model fallback routing.
 * Primary -> Fallback 1 -> Fallback 2 -> openrouter/free.
 * Rotates automatically on 404, 429, 5xx, 15s timeout, empty streams, or malformed tool calls.
 */
export async function resolveGatewayRoute(
  _principal: AuthedPrincipal,
  _input: ModelRouteInput,
): Promise<ModelRoutePlan> {
  const chain = await refreshOpenRouterFreeChainIfStale().catch(() => openRouterFreeChain());
  return {
    policyId: 'openrouter-free-chain',
    primaryModel: chain[0]!,
    fallbackModels: [...chain.slice(1)],
    fallbackOn: 'any-error',
  };
}
