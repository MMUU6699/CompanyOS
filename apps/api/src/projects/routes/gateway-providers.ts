import { type AuthedPrincipal } from '@kortix/llm-gateway';
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { verifyProviderConnection } from '../../llm-gateway/provider-verify';
import { assertGatewayBudget, GatewayBudgetExceededError } from '../../llm-gateway/hooks';
import { capturePersonEvent } from './product-events';
import { workspaceIdParam } from '../../shared/route-params';

export function registerGatewayProvidersRoutes(): void {
  // GAP C1 — "Connected" (a secret row exists) is not the same claim as "the
  // key works". This makes ONE cheap, single-attempt completion through the
  // same resolveCandidates -> callUpstream path a real turn uses and reports
  // verified/invalid/unknown/not_connected — see provider-verify.ts for the
  // full classification rationale. Gated on PROJECT_SECRET_READ (same leaf as
  // GET /secrets): it never exposes the key itself, only whether it works, so
  // any member who can already see that the provider is connected can check
  // whether it's actually usable.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/gateway/providers/{providerId}/verify',
      tags: ['gateway'],
      summary: 'Verify a project LLM provider credential',
      ...auth,
      request: { params: z.object({ workspaceId: z.string(), providerId: z.string() }) },
      responses: {
        200: json(z.any(), 'Provider credential verification result'),
        ...errors(403, 404),
      },
    }),
    async (c: any) => {
      return c.json(
        {
          error: 'External LLM provider verification is disabled on this deployment.',
          code: 'model_selection_locked',
        },
        403,
      );
    },
  );
}
