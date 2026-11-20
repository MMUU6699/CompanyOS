import type { ModelRouteInput, ModelRoutePlan, AuthedPrincipal } from '@kortix/llm-gateway';
import { openRouterFreeChain } from '../resolution/openrouter-free';

/**
 * 100% FREE-ONLY OpenRouter multi-model fallback routing.
 * Primary -> Fallback 1 -> Fallback 2 -> openrouter/free.
 * Rotates automatically on 429, 5xx, timeouts, empty streams, or malformed tool calls.
 */
export async function resolveGatewayRoute(
  _principal: AuthedPrincipal,
  _input: ModelRouteInput,
): Promise<ModelRoutePlan> {
  const chain = openRouterFreeChain();
  return {
    policyId: 'openrouter-free-chain',
    primaryModel: chain[0]!,
    fallbackModels: [...chain.slice(1)],
    fallbackOn: 'any-error',
  };
}
