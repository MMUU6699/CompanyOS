// Claude accounts: a member's Claude Pro or Max login, stored as a named
// provider account of this project, exactly like a ChatGPT account. The LLM
// gateway uses it for Claude Code's model calls; no sandbox receives it.
//
//   GET    /v1/projects/:projectId/claude-subscription                 status
//   POST   /v1/projects/:projectId/claude-subscription/login/start     run `claude setup-token`
//   POST   /v1/projects/:projectId/claude-subscription/login/complete  paste the code
//   PUT    /v1/projects/:projectId/claude-subscription/token           paste a token
//   DELETE /v1/projects/:projectId/claude-subscription                 delete your own Claude accounts here
//
// A new account is private to its creator unless `sharing` says otherwise.
// Sharing beyond yourself needs `project.secret.write`. List, share, reconnect
// and delete one account through /v1/accounts/:accountId/secret-resources.
// Only a person signs in: a sandbox, session, service-account or API-key
// credential gets 403. No response carries the token.

import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../../types';
import { auth, errors, json } from '../../openapi';
import { accountMemberRow } from '../../iam/membership-read';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { createProjectSecretWriteRateLimitMiddleware } from '../../middleware/rate-limit';
import { randomUUID } from 'node:crypto';
import { PROJECT_ACTIONS } from '../../iam';
import { assertProjectCapability } from '../lib/http-project-access';
import { CLAUDE_TOKEN_PATTERN } from '../claude-subscription/setup-token';
import {
  ClaudeLoginFlowError,
  cancelClaudeLogins,
  completeClaudeLogin,
  startClaudeLogin,
  storeClaudeAccount,
  type ClaudeAccountTarget,
} from '../claude-subscription/flows';
import { CLAUDE_ACCOUNT, countUsableClaudeAccounts, deleteOwnClaudeAccounts } from '../../claude-subscription/accounts';
import { checkNamedConnection } from '../../secrets/provider-accounts';
import { captureProductEvent } from '../../shared/product-analytics';
import { analyticsSource } from '../../middleware/analytics-source';

const Params = z.object({ workspaceId: z.string() });

const StatusSchema = z
  .object({
    connected: z.boolean().openapi({ description: 'You may use at least one Claude account in this project: your own or one shared with you.' }),
    accounts: z.number().int().openapi({ description: 'How many Claude accounts you may use in this project.' }),
  })
  .openapi('ClaudeSubscriptionStatus');

const ConnectedSchema = z
  .object({
    connected: z.literal(true),
    secret_id: z.string().uuid().openapi({ description: 'The Claude account the sign-in created or reconnected.' }),
  })
  .openapi('ClaudeSubscriptionConnected');

const AccountFields = {
  resource_label: z.string().optional().openapi({ description: 'The new account\'s name (1–100 characters). Default "Claude".' }),
  resource_id: z.string().uuid().optional().openapi({ description: 'Reconnect this Claude account of yours instead of adding one. Send it alone.' }),
  sharing: z.record(z.string(), z.unknown()).nullable().optional().openapi({
    description: 'Who may use the new account: `{mode:"private"}` (default), `{mode:"project"}` or `{mode:"members", memberIds:[…]}`.',
  }),
};

const StartBody = z.object(AccountFields);

const StartSchema = z
  .object({
    flow_id: z.string().uuid(),
    authorize_url: z.string().openapi({ description: 'The claude.com page where the caller approves the sign-in.' }),
    expires_at: z.string(),
  })
  .openapi('ClaudeSubscriptionLoginStart');

const CompleteBody = z.object({
  flow_id: z.string().uuid().openapi({ description: 'The flow id that start returned.' }),
  code: z.string().min(1).max(2048).openapi({ description: 'The code platform.claude.com showed after the approval.' }),
});

const TokenBody = z.object({
  token: z.string().openapi({ description: 'The token `claude setup-token` printed (`sk-ant-oat01-…`).' }),
  ...AccountFields,
});

type ProjectContext = Context<AppEnv>;

/** A person, with a credential of their own: a browser session or a personal token outside any session. */
function isPersonCredential(c: ProjectContext): boolean {
  const authType = c.get('authType') as string | undefined;
  if (authType === 'supabase') return true;
  return authType === 'pat' && !c.get('sessionId');
}

type Caller = { accountId: string; userId: string; projectId: string };
type Refusal = { body: { error: string; message: string; code: string }; status: 403 | 404 };

async function caller(c: ProjectContext, projectId: string): Promise<Caller | Refusal> {
  if (!isPersonCredential(c)) {
    return {
      body: { error: 'forbidden', message: 'Only a person signs in to their Claude subscription.', code: 'person_required' },
      status: 403,
    };
  }
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { body: { error: 'not_found', message: 'Project not found', code: 'not_found' }, status: 404 };
  const [member] = await accountMemberRow(loaded.row.accountId, loaded.userId);
  if (!member) {
    return {
      body: { error: 'forbidden', message: 'Only a member of this account signs in to Claude here.', code: 'member_required' },
      status: 403,
    };
  }
  return { accountId: loaded.row.accountId, userId: loaded.userId, projectId };
}

async function status(who: Caller) {
  const accounts = await countUsableClaudeAccounts(who.accountId, who.projectId, who.userId);
  return { connected: accounts > 0, accounts };
}

/**
 * The account a sign-in writes: a new one (named and shared as the body says)
 * or a reconnect. Sharing beyond the caller needs `project.secret.write`.
 */
async function accountTarget(c: ProjectContext, who: Caller, body: { resource_label?: string; resource_id?: string; sharing?: unknown }): Promise<ClaudeAccountTarget | Refusal | { body: { error: string; message: string; code: string }; status: 400 }> {
  const checked = await checkNamedConnection({
    accountId: who.accountId, projectId: who.projectId, userId: who.userId, kind: CLAUDE_ACCOUNT,
    label: body.resource_label, resourceId: body.resource_id, sharing: body.sharing, defaultLabel: 'Claude',
  });
  if (!checked.ok) return { body: { error: 'invalid_account', message: checked.error, code: 'invalid_account' }, status: checked.status as 400 | 403 | 404 };
  if (!checked.ownerOnly) {
    await assertProjectCapability(c, who.userId, who.accountId, who.projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE);
  }
  if (checked.resourceId) return { kind: 'reconnect', secretId: checked.resourceId };
  return { kind: 'new', secretId: randomUUID(), label: checked.label!, sharing: checked.sharing! };
}

export function registerClaudeSubscriptionRoutes(): void {
  // The pattern also matches `/:projectId/claude-subscription` itself.
  projectsApp.use('/:workspaceId/claude-subscription/*', createProjectSecretWriteRateLimitMiddleware());

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/claude-subscription',
      tags: ['secrets'],
      summary: 'Read whether you may use a Claude account here',
      description: 'Whether you may use at least one Claude account in this project: your own or one shared with you. No token is returned.',
      ...auth,
      request: { params: Params },
      responses: { 200: json(StatusSchema, 'Login status'), ...errors(403, 404) },
    }),
    async (c) => {
      return c.json({ connected: false, accounts: 0 }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/claude-subscription/login/start',
      tags: ['secrets'],
      summary: 'Start a Claude subscription sign-in',
      description: 'Disabled when LLM provider is locked.',
      ...auth,
      request: { params: Params, body: { content: { 'application/json': { schema: StartBody } } } },
      responses: { 200: json(StartSchema, 'The sign-in link'), ...errors(400, 403, 404, 429, 502, 503) },
    }),
    async (c) => {
      return c.json({ error: 'model_selection_locked', message: 'External LLM provider login is disabled on this deployment.', code: 'model_selection_locked' }, 403);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/claude-subscription/login/complete',
      tags: ['secrets'],
      summary: 'Finish a Claude subscription sign-in',
      description: 'Disabled when LLM provider is locked.',
      ...auth,
      request: { params: Params, body: { content: { 'application/json': { schema: CompleteBody } } } },
      responses: { 200: json(ConnectedSchema, 'Signed in'), ...errors(400, 403, 404, 409, 410, 502) },
    }),
    async (c) => {
      return c.json({ error: 'model_selection_locked', message: 'External LLM provider login is disabled on this deployment.', code: 'model_selection_locked' }, 403);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{workspaceId}/claude-subscription/token',
      tags: ['secrets'],
      summary: 'Store a Claude subscription token you made',
      description: 'Disabled when LLM provider is locked.',
      ...auth,
      request: { params: Params, body: { content: { 'application/json': { schema: TokenBody } } } },
      responses: { 200: json(ConnectedSchema, 'Stored'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      return c.json({ error: 'model_selection_locked', message: 'External LLM provider tokens are disabled on this deployment.', code: 'model_selection_locked' }, 403);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{workspaceId}/claude-subscription',
      tags: ['secrets'],
      summary: 'Delete your own Claude accounts in this project',
      description: 'Disabled when LLM provider is locked.',
      ...auth,
      request: { params: Params },
      responses: { 200: json(StatusSchema, 'Disconnected'), ...errors(403, 404) },
    }),
    async (c) => {
      return c.json({ error: 'model_selection_locked', message: 'External LLM provider accounts are disabled on this deployment.', code: 'model_selection_locked' }, 403);
    },
  );
}
