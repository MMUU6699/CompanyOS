import { createRoute, z } from '@hono/zod-openapi';
import { sessionProviderSecretPools } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { PROJECT_ACTIONS } from '../../iam';
import { agentMayUseEnv } from '../../iam/agent-scope';
import { memberMayReadProject } from '../../secrets/account-resource';
import { MAX_KEYS_PER_PROVIDER, mayUseProviderKeys, providerEnvVarOf } from '../../secrets/provider-key-selection';
import { loadProjectForUser, loadVisibleSession, assertProjectCapability, projectCapabilityAllowed } from '../lib/access';
import { mayChangeSessionModel } from '../lib/session-model-change';
import { resolveSessionAgentGrant } from '../lib/secret-grant';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { resolveSessionPersonalOwner } from '../lib/personal-resources';

const Params = z.object({ workspaceId: z.string().uuid(), sessionId: z.string().uuid(), providerId: z.string().min(1).max(100) });
const Pool = z.object({ provider_id: z.string(), configured: z.boolean(), secret_ids: z.array(z.string()) });
const PersonalKeysReason = z.enum(['shared', 'prompted_by_another_member', 'no_person']);
type PersonalKeysReason = z.infer<typeof PersonalKeysReason>;

/**
 * Why a session reaches no one's own keys. Visibility is one cause, not the
 * only one: a private session also acts for nobody when another member has
 * prompted it (`on_behalf_of_cleared_at`, see ON_BEHALF_OF_CLEARED_KEY in
 * lib/on-behalf-of.ts), or when its token has no `on_behalf_of` at all (minted
 * before 2026-09-22, or for an unattended run).
 */
export function personalKeysReason(row: {
  visibility?: string | null;
  metadata?: Record<string, unknown> | null;
}): PersonalKeysReason {
  if (row.visibility !== 'private') return 'shared';
  if (typeof row.metadata?.on_behalf_of_cleared_at === 'string') return 'prompted_by_another_member';
  return 'no_person';
}

const PERSONAL_KEY_REFUSAL: Record<PersonalKeysReason, { error: string; code: string }> = {
  shared: {
    error: 'This session is shared, so it can use only keys shared with the whole project',
    code: 'SHARED_SESSION_PERSONAL_KEY',
  },
  prompted_by_another_member: {
    error: 'Another member has prompted this session, so it no longer acts for its owner and can use only keys shared with the whole project',
    code: 'SESSION_PROMPTED_BY_ANOTHER_MEMBER',
  },
  no_person: {
    error: 'This session does not act for a person (it started before personal keys existed, or unattended), so it can use only keys shared with the whole project. Start a new session to use your own keys',
    code: 'SESSION_ACTS_FOR_NO_ONE',
  },
};
const Input = z.object({ secret_ids: z.array(z.string().uuid()).max(MAX_KEYS_PER_PROVIDER).nullable() }).strict();

/**
 * May the caller select these keys for a session? Its agent must be granted
 * the provider's key name, and each key must be one the caller may use: shared
 * with the whole project, or granted to the caller.
 *
 * The route has already authorized the caller, so no member check runs here.
 * A caller that is not an account member, such as a service account with a
 * project role, holds no grant (grants are written only for account members),
 * so it may select only keys shared with the whole project.
 */
export async function validateProviderSecretPool(input: {
  accountId: string; projectId: string; repoUrl: string; defaultBranch: string | null;
  manifestPath: string | null; agentName: string; userId: string;
  providerId: string; ids: string[];
}): Promise<{ status: 400 | 403 | 409; error: string } | null> {
  const envVar = providerEnvVarOf(input.providerId);
  if (!envVar) return { status: 400, error: 'Unknown provider' };
  if (input.ids.length > MAX_KEYS_PER_PROVIDER || new Set(input.ids).size !== input.ids.length) {
    return { status: 400, error: 'Invalid or duplicate secret id' };
  }
  if (!input.ids.length) return null;
  let grant;
  try {
    grant = await resolveSessionAgentGrant({
      projectId: input.projectId, repoUrl: input.repoUrl, defaultBranch: input.defaultBranch,
      manifestPath: input.manifestPath, sessionAgent: input.agentName,
      forceRefresh: true,
    });
  } catch {
    return { status: 409, error: 'Agent grant unavailable' };
  }
  if (!agentMayUseEnv(grant, envVar)) return { status: 403, error: 'Agent cannot use this provider secret' };
  const usable = await mayUseProviderKeys({
    accountId: input.accountId, projectId: input.projectId, providerId: input.providerId, ids: input.ids,
    grantUserId: input.userId,
  });
  return usable ? null : { status: 403, error: 'Secret unavailable or not granted' };
}

export function registerProviderSecretPoolsRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'get', path: '/{workspaceId}/sessions/{sessionId}/provider-secret-pools',
    tags: ['sessions'], summary: 'List configured session provider secret pools', ...auth,
    request: { params: Params.omit({ providerId: true }) },
    responses: { 200: json(z.object({
      pools: z.array(Pool),
      can_edit: z.boolean(),
      // The person whose own keys this session reaches, or null with the reason.
      personal_user_id: z.string().nullable(),
      personal_keys_reason: PersonalKeysReason.nullable(),
    }), 'Configured session pools'), ...errors(403, 404) },
  }), async (c: any) => {
    const { workspaceId: projectId, sessionId } = c.req.param();
    if (callerKortixSessionId(c) && callerKortixSessionId(c) !== sessionId) return c.json({ error: 'Not found' }, 404);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    const ownerId = visible.ownerIsMachine ? null : visible.row.createdBy;
    const [rows, personalUserId] = await Promise.all([
      db.select({ provider_id: sessionProviderSecretPools.providerId, secret_ids: sessionProviderSecretPools.secretIds })
        .from(sessionProviderSecretPools).where(eq(sessionProviderSecretPools.sessionId, sessionId)),
      ownerId
        ? resolveSessionPersonalOwner({ projectId, accountId: loaded.row.accountId, sessionId, legacyUserId: ownerId }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const canEdit = mayChangeSessionModel(visible) && !visible.ownerIsMachine
      && (ownerId === loaded.userId
        || await projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_READ));
    return c.json({
      pools: rows.map(({ provider_id, secret_ids }) => ({ provider_id, secret_ids, configured: true })),
      can_edit: canEdit,
      personal_user_id: personalUserId,
      personal_keys_reason: personalUserId ? null : personalKeysReason(visible.row),
    });
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{workspaceId}/sessions/{sessionId}/provider-secret-pools/{providerId}',
    tags: ['sessions'], summary: 'Read the selected provider secret pool', ...auth,
    request: { params: Params }, responses: { 200: json(Pool, 'Session pool'), ...errors(403, 404) },
  }), async (c: any) => {
    const { workspaceId: projectId, sessionId, providerId } = c.req.param();
    if (callerKortixSessionId(c) && callerKortixSessionId(c) !== sessionId) return c.json({ error: 'Not found' }, 404);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    const [pool] = await db.select({ ids: sessionProviderSecretPools.secretIds }).from(sessionProviderSecretPools)
      .where(and(eq(sessionProviderSecretPools.sessionId, sessionId), eq(sessionProviderSecretPools.providerId, providerId))).limit(1);
    return c.json({ provider_id: providerId, configured: Boolean(pool), secret_ids: pool?.ids ?? [] });
  });

  projectsApp.openapi(createRoute({
    method: 'put', path: '/{workspaceId}/sessions/{sessionId}/provider-secret-pools/{providerId}',
    tags: ['sessions'], summary: 'Replace one session provider secret pool', ...auth,
    request: { params: Params, body: { content: { 'application/json': { schema: Input } } } },
    responses: { 200: json(Pool, 'Session pool'), ...errors(400, 403, 404, 409) },
  }), async (c: any) => {
    return c.json({ error: 'Provider secret pool selection is disabled on this deployment.', code: 'model_selection_locked' }, 403);
  });
}
