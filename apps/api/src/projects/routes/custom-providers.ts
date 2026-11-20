import { createRoute, z } from '@hono/zod-openapi';
import { PROJECT_ACTIONS } from '../../iam';
import {
  type CustomLlmProviderDefinition,
  CustomLlmProviderInputSchema,
  customProviderIdError,
  probeCustomModels,
  customProviderIdFromSecret,
  customProviderSecretName,
} from '../../llm-gateway/custom-providers';
import { auth, errors, json } from '../../openapi';
import { listProjectCustomProviders, writeProjectCustomProvider } from '../../repositories/project-model-access';
import { config } from '../../config';
import { assertSafeEgressUrl, UnsafeEgressError } from '../../shared/ssrf-guard';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { propagateProjectSecretsToActiveSandboxes } from '../lib/sandbox-env-sync';
import { firstGatewayKeyValue } from '../../llm-gateway/credentials/gateway-keys';
import { moveLegacyProviderKeysNamed } from '../../secrets/llm-credential-move';

const CustomLlmProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  base_url: z.string().nullable(),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    /** Context window in tokens; absent: the gateway serves 128k. */
    context: z.number().optional(),
    /** Max output tokens; absent: the context window, else 16k. */
    output: z.number().optional(),
    /** Reads images; absent: false. */
    attachment: z.boolean().optional(),
    /** Reasons and takes `reasoning_effort`; absent: false. */
    reasoning: z.boolean().optional(),
  })),
  secret_name: z.string(),
  has_key: z.boolean(),
  /** false: a `CUSTOM_<ID>_API_KEY` secret with no endpoint saved yet. */
  configured: z.boolean(),
}).openapi('CustomLlmProvider');
type CustomLlmProviderView = z.infer<typeof CustomLlmProviderSchema>;

const Params = z.object({ workspaceId: z.string(), providerId: z.string() });

function view(provider: CustomLlmProviderDefinition, secretNames: string[]): CustomLlmProviderView {
  const secretName = customProviderSecretName(provider.id);
  return { ...provider, secret_name: secretName, has_key: secretNames.includes(secretName), configured: true };
}

/**
 * Models → Custom: a project's own OpenAI-compatible endpoints, served by the
 * LLM gateway (llm-gateway/custom-providers.ts). The key is `CUSTOM_<ID>_API_KEY`,
 * a named account of provider `<id>` (a write through the secrets routes lands
 * there, `secrets/llm-credential-move.ts`), or a legacy project secret not
 * moved yet.
 */
export function registerCustomProvidersRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'get', path: '/{workspaceId}/custom-providers', tags: ['projects'],
    summary: 'List the custom LLM providers of a project', ...auth,
    request: { params: Params.omit({ providerId: true }) },
    responses: { 200: json(z.object({ providers: z.array(CustomLlmProviderSchema) }), 'Custom providers'), ...errors(403, 404) },
  }), async (c) => {
    const { workspaceId: projectId } = c.req.valid('param');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    return c.json({ providers: [] });
  });

  projectsApp.openapi(createRoute({
    method: 'put', path: '/{workspaceId}/custom-providers/{providerId}', tags: ['projects'],
    summary: 'Create or replace a custom LLM provider', ...auth,
    request: { params: Params, body: { content: { 'application/json': { schema: CustomLlmProviderInputSchema } } } },
    responses: { 200: json(CustomLlmProviderSchema, 'The saved provider'), ...errors(400, 403, 404) },
  }), async (c) => {
    return c.json({ error: 'Custom LLM providers are disabled on this deployment.', code: 'model_selection_locked' }, 403);
  });

  projectsApp.openapi(createRoute({
    method: 'delete', path: '/{workspaceId}/custom-providers/{providerId}', tags: ['projects'],
    summary: 'Remove a custom LLM provider', ...auth,
    request: { params: Params },
    responses: { 204: { description: 'Removed' }, ...errors(403, 404) },
  }), async (c) => {
    return c.json({ error: 'Custom LLM providers are disabled on this deployment.', code: 'model_selection_locked' }, 403);
  });
}
