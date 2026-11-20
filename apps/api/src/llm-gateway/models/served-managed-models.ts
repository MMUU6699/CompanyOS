import { openRouterFreeManagedModel, primaryOpenRouterFreeModelId } from '../resolution/openrouter-free';
import type { ManagedModel } from './managed-models';

/**
 * Locked 100% FREE-ONLY OpenRouter managed lineup.
 */
export function servedManagedModels(): readonly ManagedModel[] {
  return [openRouterFreeManagedModel()];
}

/**
 * Locked platform default model (Primary `:free` OpenRouter model).
 */
export function platformDefaultModelId(): string {
  return primaryOpenRouterFreeModelId();
}

/** Locked platform vision model (100% free OpenRouter chain includes VL fallback). */
export function platformVisionModelId(): string {
  return primaryOpenRouterFreeModelId();
}
