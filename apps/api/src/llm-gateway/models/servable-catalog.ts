import { openRouterFreeGatewayModel, primaryOpenRouterFreeModelId } from '../resolution/openrouter-free';
import type { gatewayModelCatalog } from './catalog-models';
import type { UnavailableModelMark } from './picker-catalog';

type GatewayModel = ReturnType<typeof gatewayModelCatalog>[string];

export interface ServableProjectCatalog {
  /** Wire model id → catalog record, stamped with the project's enablement,
   *  and `available: false` when only a default names it and its provider is
   *  not connected for the caller. */
  models: Record<string, GatewayModel & { enabled: boolean } & Partial<UnavailableModelMark>>;
  modelOverrides: Record<string, boolean>;
  defaultModel: string | undefined;
  usingDefaults: boolean;
}

/**
 * Locked 100% FREE-ONLY OpenRouter model catalog.
 */
export async function servableProjectCatalog(_input: {
  projectId: string;
  accountId: string;
  principalUserId: string | null | undefined;
  personalUserId?: string | null;
  withoutRefusedKeys?: boolean;
}): Promise<ServableProjectCatalog> {
  const primaryId = primaryOpenRouterFreeModelId();
  return {
    models: {
      [primaryId]: {
        ...openRouterFreeGatewayModel(primaryId),
        enabled: true,
      },
    },
    modelOverrides: {},
    defaultModel: primaryId,
    usingDefaults: true,
  };
}
