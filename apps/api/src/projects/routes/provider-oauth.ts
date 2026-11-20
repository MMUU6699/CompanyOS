/** LLM provider OAuth device flow (ChatGPT via Codex, OpenCode Zen and Go via the OpenCode Console): start, poll, status, disconnect. */
import { parseSharingIntent } from '../../connectors/share';
import { createHash, randomUUID } from 'node:crypto';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json, lenientBody } from '../../openapi';
import { recordAuditEvent, runAuditedTransaction } from '../../shared/audit';
import { db } from '../../shared/db';
import { accountMemberRow } from '../../iam/membership-read';
import { pollCodexDeviceAuth, startCodexDeviceAuth } from '../codex-device-auth';
import {
  OPENCODE_CONSOLE_PROVIDERS,
  parseOpencodeLogin,
  pollOpencodeDeviceAuth,
  startOpencodeDeviceAuth,
} from '../../llm-gateway/credentials/opencode-console';
import { resolveCatalogUpstream } from '../../llm-gateway/models/provider-registry';
import { requestPersonalOwner } from '../lib/personal-resources';
import {
  decryptProjectSecret,
  encryptProjectSecret,
  resolveProjectSecretForConsumer,
} from '../secrets';
import { propagateProjectSecretsToActiveSandboxes } from '../lib/sandbox-env-sync';
import { isGatewayManagedEnv } from '../../llm-gateway/sandbox-credentials';
import { createRoute, z } from '@hono/zod-openapi';
import { accountSecretGrants } from '@kortix/db';
import { reconnectProviderAccount, writeProviderAccount } from '../../secrets/provider-accounts';
import { deleteNamedCopiesOfLegacySecrets } from '../../secrets/llm-credential-ledger';
import { projectSecrets } from '@kortix/db';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import {
  loadProjectForUser,
  assertProjectCapability,
  projectCapabilityAllowed,
} from '../lib/access';
import { projectsApp } from '../lib/app';
import { parseOAuthStartRequest } from '../lib/provider-oauth-request';
import {
  CODEX_AUTH_JSON_SECRET_NAME,
  loadSecretViewsForUser,
  normalizeString,
} from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';
import { rethrowDatabaseError } from '../../shared/database-errors';
import { capturePersonEvent } from './product-events';
import { workspaceIdParam } from '../../shared/route-params';

// ─── Provider OAuth device flow (poll-based) ───────────────────────────────
//
// Connect a subscription-backed LLM provider (a ChatGPT Plus/Pro account via
// the OpenAI Codex device grant, or an OpenCode Console account for OpenCode
// Zen and Go) and save the resulting login as the provider's project secret. Only the LLM gateway can decrypt this
// value. The sandbox receives neither the token nor an opaque handle.
//
// Two quick, NON-streaming calls so they survive any edge (a long-lived
// streaming response gets reset by Cloudflare) and any replica:
//   POST …/oauth/:provider/start → kicks the device flow in a DETACHED
//        background task on this replica, returns the device challenge.
//   POST …/oauth/:provider/poll  → ANY replica reads the shared DB flow row;
//        once the user finishes authorizing, writes the secret and returns it.
// The in-flight flow lives in `kortix.oauth_provider_flows` (not replica
// memory), so start and poll need not hit the same pod. The detached task
// isn't tied to a client connection, so nothing the edge does can kill it.

// Kortix provider id → how its device flow runs and where the login is saved.
// `resourceProviderId` tags a named (pooled)
// connection. `secretName` is read lazily: the OpenCode names come from the
// runtime catalog (a Console login is stored as the provider's own key secret,
// see llm-gateway/credentials/opencode-console.ts).
interface OAuthProvider {
  label: string;
  secretName: string;
  resourceProviderId: string;
  start: () => Promise<{ verificationUrl: string; userCode: string; handle: string; intervalMs: number }>;
  poll: (handle: string, userCode: string) => Promise<
    { status: 'pending' } | { status: 'failed'; error: string } | { status: 'authorized'; authJson: string }>;
  /** Whether a stored value is this login (an OpenCode key secret may hold a plain API key). */
  isLogin: (value: string) => boolean;
}

function oauthProvider(provider: string): OAuthProvider | null {
  if (provider === 'openai') {
    return {
      label: 'ChatGPT', secretName: CODEX_AUTH_JSON_SECRET_NAME, resourceProviderId: 'codex',
      start: async () => {
        const c = await startCodexDeviceAuth();
        return { verificationUrl: c.verificationUrl, userCode: c.userCode, handle: c.deviceAuthId, intervalMs: c.intervalMs };
      },
      poll: (handle, userCode) => pollCodexDeviceAuth({ deviceAuthId: handle, userCode }),
      isLogin: () => true,
    };
  }
  const secretName = OPENCODE_CONSOLE_PROVIDERS[provider] ? resolveCatalogUpstream(provider)?.envVar : null;
  if (!secretName) return null;
  return {
    label: 'OpenCode', secretName, resourceProviderId: provider,
    start: async () => {
      const c = await startOpencodeDeviceAuth();
      return { verificationUrl: c.verificationUrl, userCode: c.userCode, handle: c.deviceCode, intervalMs: c.intervalMs };
    },
    poll: (handle) => pollOpencodeDeviceAuth(handle),
    isLogin: (value) => parseOpencodeLogin(value) !== null,
  };
}

// How long the encrypted flow handle stays valid (OpenAI expires the device
// code on its side too; this just bounds the opaque handle clients hold).
const DEVICE_AUTH_TTL_MS = 15 * 60 * 1000;
// Floor for the client poll cadence (OpenAI returns its own suggested interval).
const OAUTH_POLL_INTERVAL_MS = 3000;

/** A stable named-account id for one device flow (its device code), as a UUID. */
function flowSecretId(deviceCode: string): string {
  const hex = createHash('sha256').update(`provider-oauth-flow:${deviceCode}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A named connection only its owner can use: private, or restricted to the owner
 * alone. Anything wider shares a credential, which is a project secret write. */
function sharingIsOwnerOnly(sharing: ReturnType<typeof parseSharingIntent> | undefined, ownerId: string): boolean {
  if (sharing?.mode === 'private') return true;
  return sharing?.mode === 'members' && !sharing.groupIds?.length &&
    (sharing.memberIds ?? []).every((memberId) => memberId === ownerId);
}

const accountKind = (cfg: OAuthProvider) => ({ providerId: cfg.resourceProviderId, name: cfg.secretName, label: cfg.label });

// Best-effort token expiry (ms remaining) from a stored auth.json, for display.
function authExpiresInMs(authJson: string): number | null {
  try {
    const parsed = JSON.parse(authJson);
    // An OpenCode Console login is flat: { type, access, expires, ... }.
    if (typeof parsed?.expires === 'number') return Math.max(0, parsed.expires - Date.now());
    // opencode auth.json is keyed by provider: { openai: { expires, ... } }.
    for (const entry of Object.values(parsed ?? {})) {
      const expires = (entry as { expires?: unknown })?.expires;
      if (typeof expires === 'number' && Number.isFinite(expires)) {
        return Math.max(0, expires - Date.now());
      }
    }
  } catch {
    // not parseable / no expiry — treat as unknown
  }
  return null;
}

export function registerProviderOauthRoutes(): void {
  // ─── POST /v1/projects/:projectId/oauth/:provider/start ────────────────────
  // Kick the device flow in a detached background task; return the challenge.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/oauth/{provider}/start',
      tags: ['secrets'],
      summary: 'Start an LLM provider OAuth login',
      ...auth,
        request: {
          params: z.object({ workspaceId: z.string(), provider: z.string() }),
          body: { content: { 'application/json': { schema: lenientBody({
              resource_label: z.string().optional().openapi({ description: 'Label of the connection.' }),
              resource_id: z.string().optional().openapi({ description: 'Existing connection to re-authorize.' }),
              sharing: z.record(z.string(), z.any()).optional().openapi({ description: 'Who can use the connection.' }),
            }) } } },
        },
      responses: {
          200: json(z.any(), 'Device challenge'),
          ...errors(400, 401, 403, 404, 502),
      },
    }),
    async (c: any) => {
      return c.json({ error: 'External LLM provider OAuth is disabled on this deployment.', code: 'model_selection_locked' }, 403);
    },
  );

  // ─── POST /v1/projects/:projectId/oauth/:provider/poll ─────────────────────
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/oauth/{provider}/poll',
      tags: ['secrets'],
      summary: 'Poll an LLM provider OAuth login',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), provider: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody({
          flow_id: z.string().openapi({ description: 'Flow id returned by start.' }),
        }) } } },
      },
      responses: {
        200: json(z.any(), 'Poll result'),
        ...errors(400, 401, 403, 404),
      },
    }),
    async (c: any) => {
      return c.json({ error: 'External LLM provider OAuth is disabled on this deployment.', code: 'model_selection_locked' }, 403);
    },
  );

  // ─── GET /v1/projects/:projectId/oauth ─────────────────────────────────────
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/oauth',
      tags: ['secrets'],
      summary: 'List connected LLM provider logins',
      ...auth,
      request: { params: z.object({ workspaceId: z.string() }) },
      responses: {
        200: json(z.any(), 'Configured OAuth credentials'),
        ...errors(401, 404),
      },
    }),
    async (c: any) => {
      return c.json({ items: [] });
    },
  );

  // ─── DELETE /v1/projects/:projectId/oauth/:provider ────────────────────────
  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{workspaceId}/oauth/{provider}',
      tags: ['secrets'],
      summary: 'Disconnect an LLM provider login',
      ...auth,
      request: { params: z.object({ workspaceId: z.string(), provider: z.string() }) },
      responses: {
        200: json(z.any(), 'OK'),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      return c.json({ error: 'External LLM provider OAuth is disabled on this deployment.', code: 'model_selection_locked' }, 403);
    },
  );
}
