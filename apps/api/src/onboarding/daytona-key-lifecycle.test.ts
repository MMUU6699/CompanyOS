/**
 * Phase 2 unit tests: key lifecycle, poll CAS state machine, disconnect cleanup,
 * org-switch warning, per-IP active flow cap, and /v1/onboarding strict rate limit.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const mockConfig = {
  DAYTONA_API_KEY: '',
  KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK: false,
  DAYTONA_SERVER_URL: 'https://daytona.example.test/api',
  DAYTONA_TARGET: 'eu',
  API_KEY_SECRET: '00000000000000000000000000000000',
  DAYTONA_CREDENTIALS_ENCRYPTION_KEY: '00000000000000000000000000000000',
  KORTIX_SANDBOX_GHCR_IMAGE: 'ghcr.io/mmuu6699/kortix-sandbox:20261121-da3f5cdd',
  KORTIX_DAYTONA_KEY_TTL_DAYS: 0,
  KORTIX_DAYTONA_MAX_ACTIVE_FLOWS_PER_IP: 2,
  KORTIX_TRUSTED_PROXY_HOPS: 1,
};

mock.module('../config', () => ({ config: mockConfig }));
mock.module('../lib/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const stoppedSandboxes: Array<{ id: string; apiKey?: string }> = [];
mock.module('../shared/daytona', () => ({
  stopDaytonaSandboxById: async (id: string, apiKey?: string) => {
    stoppedSandboxes.push({ id, apiKey });
    return true;
  },
}));

// In-memory mock DB covering daytonaConnectFlows, userDaytonaCredentials, sessionSandboxes.
interface FlowRow {
  flowId: string;
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  status: 'pending' | 'exchanging' | 'approved' | 'claimed' | 'expired';
  encryptedApiKey: string | null;
  encryptionIv: string | null;
  encryptionTag: string | null;
  daytonaKeyName: string | null;
  daytonaOrgId: string | null;
  daytonaRegion: string | null;
  claimToken: string | null;
  clientIpHash: string | null;
  terminalErrorCode: string | null;
  terminalErrorMessage: string | null;
  terminalErrorStatus: number | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface CredRow {
  userId: string;
  encryptedApiKey: string;
  encryptionIv: string;
  encryptionTag: string;
  daytonaOrgId: string;
  daytonaRegion: string;
  daytonaKeyName: string | null;
  daytonaKeyExpiresAt: Date | null;
  previousDaytonaOrgId: string | null;
  previousOrgReplacedAt: Date | null;
  snapshotName: string | null;
  snapshotStatus: 'pending' | 'pulling' | 'active' | 'inactive' | 'failed';
  snapshotError: string | null;
  snapshotAttempts: number | null;
  snapshotNextRetryAt: Date | null;
  maxRunningSandboxes: number | null;
  maxNonArchivedSandboxes: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const flowsTable = new Map<string, FlowRow>();
const credsTable = new Map<string, CredRow>();
const activeSessionSandboxes: Array<{ externalId: string; ownerUserId: string; orgId: string }> = [];

// Identify table from drizzle Table symbol / internal name.
function tableNameOf(tbl: any): string {
  return (
    tbl?.[Symbol.for('drizzle:Name')] ||
    tbl?._?.name ||
    ''
  );
}

// Track SQL parameter values for simple predicates by inspecting drizzle chunks.
function extractStringParams(cond: any, out: unknown[] = []): unknown[] {
  if (!cond) return out;
  if (Array.isArray(cond)) {
    for (const item of cond) extractStringParams(item, out);
    return out;
  }
  if (typeof cond === 'object') {
    if ('value' in cond && (typeof cond.value === 'string' || cond.value instanceof Date || Array.isArray(cond.value))) {
      out.push(cond.value);
    }
    if ('queryChunks' in cond) {
      extractStringParams(cond.queryChunks, out);
    }
  }
  return out;
}

function makeFakeDb() {
  const api: any = {
    select: () => ({
      from: (tbl: any) => ({
        where: (cond: any) => ({
          limit: async () => {
            const tname = tableNameOf(tbl);
            const params = extractStringParams(cond);
            if (tname === 'daytona_connect_flows') {
              const all = [...flowsTable.values()];
              const byFlowId = all.filter((f) => params.includes(f.flowId));
              if (byFlowId.length > 0) return byFlowId;
              const byClaim = all.filter((f) => f.claimToken && params.includes(f.claimToken));
              if (byClaim.length > 0) return byClaim;
              const byIp = all.filter(
                (f) =>
                  f.clientIpHash &&
                  params.includes(f.clientIpHash) &&
                  ['pending', 'exchanging', 'approved'].includes(f.status) &&
                  f.expiresAt.getTime() > Date.now(),
              );
              if (byIp.length > 0) return byIp;
              // Expired flows sweep query:
              const expired = all.filter(
                (f) =>
                  ['pending', 'exchanging', 'approved'].includes(f.status) &&
                  f.expiresAt.getTime() < Date.now(),
              );
              return expired;
            }
            if (tname === 'user_daytona_credentials') {
              const all = [...credsTable.values()];
              const byUser = all.filter((c) => params.includes(c.userId));
              if (byUser.length > 0) return byUser;
              const byOrgAndKey = all.filter(
                (c) => params.includes(c.daytonaOrgId) && c.daytonaKeyName && params.includes(c.daytonaKeyName),
              );
              if (byOrgAndKey.length > 0) return byOrgAndKey;
              return [];
            }
            if (tname === 'session_sandboxes') {
              return activeSessionSandboxes.map((s) => ({ externalId: s.externalId }));
            }
            return [];
          },
          then: (resolve: (v: any) => void) => {
            const tname = tableNameOf(tbl);
            const params = extractStringParams(cond);
            if (tname === 'user_daytona_credentials') {
              resolve([...credsTable.values()].filter((c) => params.includes(c.daytonaOrgId)));
              return;
            }
            if (tname === 'daytona_connect_flows') {
              resolve(
                [...flowsTable.values()].filter(
                  (f) =>
                    f.daytonaOrgId &&
                    params.includes(f.daytonaOrgId) &&
                    ['exchanging', 'approved'].includes(f.status) &&
                    f.expiresAt.getTime() > Date.now(),
                ),
              );
              return;
            }
            resolve([]);
          },
        }),
      }),
    }),
    insert: (tbl: any) => ({
      values: (vals: any) => {
        const tname = tableNameOf(tbl);
        const doInsert = () => {
          if (tname === 'daytona_connect_flows') {
            const now = new Date();
            flowsTable.set(vals.flowId, {
              encryptedApiKey: null,
              encryptionIv: null,
              encryptionTag: null,
              daytonaKeyName: null,
              daytonaOrgId: null,
              daytonaRegion: null,
              claimToken: null,
              clientIpHash: null,
              terminalErrorCode: null,
              terminalErrorMessage: null,
              terminalErrorStatus: null,
              createdAt: now,
              updatedAt: now,
              ...vals,
            });
          } else if (tname === 'user_daytona_credentials') {
            const now = new Date();
            const existing = credsTable.get(vals.userId);
            credsTable.set(vals.userId, {
              daytonaKeyName: null,
              daytonaKeyExpiresAt: null,
              previousDaytonaOrgId: existing?.previousDaytonaOrgId ?? null,
              previousOrgReplacedAt: existing?.previousOrgReplacedAt ?? null,
              snapshotAttempts: 0,
              snapshotNextRetryAt: null,
              maxRunningSandboxes: null,
              maxNonArchivedSandboxes: null,
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
              ...vals,
            });
          }
        };
        return {
          onConflictDoUpdate: async ({ set }: { set: any }) => {
            if (tname === 'user_daytona_credentials') {
              const existing = credsTable.get(vals.userId);
              if (existing) {
                credsTable.set(vals.userId, { ...existing, ...set });
              } else {
                doInsert();
              }
            }
          },
          then: (resolve: (v: any) => void) => {
            doInsert();
            resolve([]);
          },
        };
      },
    }),
    update: (tbl: any) => ({
      set: (patch: any) => ({
        where: (cond: any) => {
          const tname = tableNameOf(tbl);
          const params = extractStringParams(cond);
          const apply = (): any[] => {
            if (tname === 'daytona_connect_flows') {
              // Identify flowId from params (or scan all for stuck exchanging sweep).
              const targetFlow = [...flowsTable.values()].find((f) => params.includes(f.flowId));
              if (!targetFlow) {
                // Bulk stuck exchanging sweep
                const out: FlowRow[] = [];
                for (const f of flowsTable.values()) {
                  if (f.status === 'exchanging' && f.updatedAt.getTime() < Date.now() - 90_000 && f.expiresAt.getTime() > Date.now()) {
                    Object.assign(f, patch);
                    out.push(f);
                  }
                }
                return out;
              }
              // Enforce conditional status CAS!
              const allowedStatuses: string[] = [];
              for (const p of params) {
                if (typeof p === 'string' && ['pending', 'exchanging', 'approved', 'claimed', 'expired'].includes(p)) {
                  allowedStatuses.push(p);
                } else if (Array.isArray(p)) {
                  for (const item of p) {
                    if (typeof item === 'string') allowedStatuses.push(item);
                  }
                }
              }
              if (allowedStatuses.length > 0 && !allowedStatuses.includes(targetFlow.status)) {
                return [];
              }
              // Special guard: if status is 'exchanging' and patch sets status='exchanging', only allow if stale >90s
              if (targetFlow.status === 'exchanging' && patch.status === 'exchanging') {
                if (Date.now() - targetFlow.updatedAt.getTime() < 90_000) return [];
              }
              Object.assign(targetFlow, patch);
              return [{ ...targetFlow }];
            }
            if (tname === 'user_daytona_credentials') {
              const target = [...credsTable.values()].find((c) => params.includes(c.userId));
              if (target) {
                Object.assign(target, patch);
                return [{ ...target }];
              }
            }
            return [];
          };
          let applied: any[] | null = null;
          const run = () => {
            if (applied === null) applied = apply();
            return applied;
          };
          return {
            returning: async () => run(),
            then: (resolve: (v: any) => void) => resolve(run()),
            catch: () => Promise.resolve(run()),
          };
        },
      }),
    }),
    delete: (tbl: any) => ({
      where: (cond: any) => {
        const tname = tableNameOf(tbl);
        const params = extractStringParams(cond);
        if (tname === 'user_daytona_credentials') {
          for (const [uid] of credsTable.entries()) {
            if (params.includes(uid)) credsTable.delete(uid);
          }
        }
        return Promise.resolve([]);
      },
    }),
    transaction: async (fn: (tx: any) => Promise<any>) => fn(api),
  };
  return api;
}

mock.module('../shared/db', () => ({ db: makeFakeDb(), hasDatabase: true }));

const { encryptDaytonaApiKey } = await import('./daytona-crypto');
const {
  claimDaytonaConnect,
  disconnectUserDaytona,
  mintPermanentDaytonaKey,
  pollDaytonaConnect,
  reapExpiredDaytonaConnectFlowsOnce,
  startDaytonaConnect,
} = await import('./daytona-service');
const { createPublicEdgeRateLimitMiddleware } = await import('../middleware/public-edge-rate-limit');

const originalFetch = global.fetch;

beforeEach(() => {
  flowsTable.clear();
  credsTable.clear();
  activeSessionSandboxes.length = 0;
  stoppedSandboxes.length = 0;
  global.fetch = originalFetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('Phase 2 key lifecycle & onboarding hardening', () => {
  test('cleanupStaleKortixApiKeys NEVER deletes any referenced key even with 4 users sharing one org', async () => {
    const orgId = 'org-shared-1';
    for (let i = 1; i <= 4; i++) {
      const uid = `user-${i}`;
      const enc = encryptDaytonaApiKey(uid, `dtn_key_${i}_abcdefghijklmnop`);
      credsTable.set(uid, {
        userId: uid,
        encryptedApiKey: enc.encryptedApiKey,
        encryptionIv: enc.encryptionIv,
        encryptionTag: enc.encryptionTag,
        daytonaOrgId: orgId,
        daytonaRegion: 'eu',
        daytonaKeyName: `kortix-app-flow-user${i}`,
        daytonaKeyExpiresAt: null,
        previousDaytonaOrgId: null,
        previousOrgReplacedAt: null,
        snapshotName: null,
        snapshotStatus: 'active',
        snapshotError: null,
        snapshotAttempts: 0,
        snapshotNextRetryAt: null,
        maxRunningSandboxes: null,
        maxNonArchivedSandboxes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    const deletedKeyNames: string[] = [];
    const oldDate = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    global.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api-keys') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify([
            { name: 'kortix-app-flow-user1', createdAt: oldDate },
            { name: 'kortix-app-flow-user2', createdAt: oldDate },
            { name: 'kortix-app-flow-user3', createdAt: oldDate },
            { name: 'kortix-app-flow-user4', createdAt: oldDate },
            { name: 'kortix-app-flow-orphan-old', createdAt: oldDate },
          ]),
          { status: 200 },
        );
      }
      if (init?.method === 'DELETE' && u.includes('/api-keys/')) {
        deletedKeyNames.push(decodeURIComponent(u.split('/api-keys/')[1]!));
        return new Response(null, { status: 204 });
      }
      if (init?.method === 'POST' && u.endsWith('/api-keys')) {
        const body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ value: 'dtn_minted_new_key_1234567890', name: body.name }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const minted = await mintPermanentDaytonaKey('jwt-test', orgId, 'flow-uuid-9999');
    expect(minted.apiKey).toBe('dtn_minted_new_key_1234567890');
    expect(minted.keyName).toContain('kortix-app-flow-flowuuid');
    // Only the truly unreferenced old key was deleted; ALL 4 referenced keys survived!
    expect(deletedKeyNames).toEqual(['kortix-app-flow-orphan-old']);
  });

  test('concurrent polls never call WorkOS twice and a late invalid_grant never overwrites approved', async () => {
    const flowId = '11111111-2222-3333-4444-555555555555';
    flowsTable.set(flowId, {
      flowId,
      deviceCode: 'dev-code-123',
      userCode: 'ABCD-EFGH',
      verificationUriComplete: 'https://auth.example.test?user_code=ABCD-EFGH',
      status: 'pending',
      encryptedApiKey: null,
      encryptionIv: null,
      encryptionTag: null,
      daytonaKeyName: null,
      daytonaOrgId: null,
      daytonaRegion: null,
      claimToken: null,
      clientIpHash: null,
      terminalErrorCode: null,
      terminalErrorMessage: null,
      terminalErrorStatus: null,
      expiresAt: new Date(Date.now() + 300_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let workosTokenCalls = 0;
    global.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/config')) {
        return new Response(
          JSON.stringify({
            oidc: {
              cli: { clientId: 'cid', issuer: 'https://oidc.example.test' },
              issuer: 'https://oidc.example.test',
            },
          }),
          { status: 200 },
        );
      }
      if (u.includes('.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            device_authorization_endpoint: 'https://oidc.example.test/device',
            token_endpoint: 'https://oidc.example.test/token',
          }),
          { status: 200 },
        );
      }
      if (u === 'https://oidc.example.test/token') {
        workosTokenCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        if (workosTokenCalls === 1) {
          return new Response(JSON.stringify({ access_token: 'jwt-1' }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      if (u.endsWith('/organizations')) {
        return new Response(
          JSON.stringify([{ id: 'org-new-1', personal: true, defaultRegionId: 'eu' }]),
          { status: 200 },
        );
      }
      if (u.endsWith('/api-keys') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ value: 'dtn_fresh_key_0123456789abcdef', name: body.name }),
          { status: 200 },
        );
      }
      if (u.endsWith('/api-keys')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const [res1, res2] = await Promise.all([
      pollDaytonaConnect(flowId),
      pollDaytonaConnect(flowId),
    ]);
    expect(workosTokenCalls).toBe(1);
    expect(res1.status).toBe('approved');
    expect(res2.status).toBe('approved');
    expect(flowsTable.get(flowId)?.status).toBe('approved');

    // Subsequent poll after approval MUST still return 'approved' (never calling WorkOS again).
    const res3 = await pollDaytonaConnect(flowId);
    expect(workosTokenCalls).toBe(1);
    expect(res3.status).toBe('approved');
  });

  test('claimDaytonaConnect records previousDaytonaOrgId and returns orgSwitched warning when changing orgs', async () => {
    const userId = 'user-switcher';
    const oldEnc = encryptDaytonaApiKey(userId, 'dtn_old_org_key_1234567890');
    credsTable.set(userId, {
      userId,
      encryptedApiKey: oldEnc.encryptedApiKey,
      encryptionIv: oldEnc.encryptionIv,
      encryptionTag: oldEnc.encryptionTag,
      daytonaOrgId: 'org-OLD-1111',
      daytonaRegion: 'eu',
      daytonaKeyName: 'kortix-app-flow-old',
      daytonaKeyExpiresAt: null,
      previousDaytonaOrgId: null,
      previousOrgReplacedAt: null,
      snapshotName: null,
      snapshotStatus: 'active',
      snapshotError: null,
      snapshotAttempts: 0,
      snapshotNextRetryAt: null,
      maxRunningSandboxes: null,
      maxNonArchivedSandboxes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const flowId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const flowEnc = encryptDaytonaApiKey(flowId, 'dtn_new_org_key_9876543210');
    flowsTable.set(flowId, {
      flowId,
      deviceCode: 'dc',
      userCode: 'uc',
      verificationUriComplete: 'https://v',
      status: 'approved',
      encryptedApiKey: flowEnc.encryptedApiKey,
      encryptionIv: flowEnc.encryptionIv,
      encryptionTag: flowEnc.encryptionTag,
      daytonaKeyName: 'kortix-app-flow-new',
      daytonaOrgId: 'org-NEW-2222',
      daytonaRegion: 'eu',
      claimToken: 'claim-token-secret-1234567890',
      clientIpHash: null,
      terminalErrorCode: null,
      terminalErrorMessage: null,
      terminalErrorStatus: null,
      expiresAt: new Date(Date.now() + 600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    global.fetch = mock(async () => new Response(JSON.stringify({ state: 'active' }), { status: 200 })) as unknown as typeof fetch;

    const claimed = await claimDaytonaConnect(userId, 'claim-token-secret-1234567890');
    expect(claimed.orgId).toBe('org-NEW-2222');
    expect(claimed.orgSwitched).toBe(true);
    expect(claimed.previousOrgId).toBe('org-OLD-1111');
    expect(claimed.warning).toContain('previous Daytona workspace');
    expect(credsTable.get(userId)?.previousDaytonaOrgId).toBe('org-OLD-1111');
    expect(credsTable.get(userId)?.daytonaKeyName).toBe('kortix-app-flow-new');
  });

  test('disconnectUserDaytona stops user sandboxes (never deletes), attempts key revoke, clears caches and deletes row', async () => {
    const userId = 'user-disc';
    const enc = encryptDaytonaApiKey(userId, 'dtn_disconnect_key_0123456789');
    credsTable.set(userId, {
      userId,
      encryptedApiKey: enc.encryptedApiKey,
      encryptionIv: enc.encryptionIv,
      encryptionTag: enc.encryptionTag,
      daytonaOrgId: 'org-disc-1',
      daytonaRegion: 'eu',
      daytonaKeyName: 'kortix-app-flow-disc',
      daytonaKeyExpiresAt: null,
      previousDaytonaOrgId: null,
      previousOrgReplacedAt: null,
      snapshotName: null,
      snapshotStatus: 'active',
      snapshotError: null,
      snapshotAttempts: 0,
      snapshotNextRetryAt: null,
      maxRunningSandboxes: null,
      maxNonArchivedSandboxes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    activeSessionSandboxes.push(
      { externalId: 'sbx-run-1', ownerUserId: userId, orgId: 'org-disc-1' },
      { externalId: 'sbx-run-2', ownerUserId: userId, orgId: 'org-disc-1' },
    );

    const revoked: string[] = [];
    global.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE' && String(url).includes('/api-keys/')) {
        revoked.push(String(url));
        return new Response(null, { status: 204 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await disconnectUserDaytona(userId);
    expect(res).toEqual({ disconnected: true, stoppedSandboxes: 2, keyRevoked: true });
    expect(stoppedSandboxes.map((s) => s.id)).toEqual(['sbx-run-1', 'sbx-run-2']);
    expect(revoked[0]).toContain('/api-keys/kortix-app-flow-disc');
    expect(credsTable.has(userId)).toBe(false);
  });

  test('startDaytonaConnect enforces per-IP active flow cap (DAYTONA_TOO_MANY_FLOWS / 429)', async () => {
    global.fetch = mock(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/config')) {
        return new Response(
          JSON.stringify({
            oidc: {
              cli: { clientId: 'cid', issuer: 'https://oidc.example.test' },
              issuer: 'https://oidc.example.test',
            },
          }),
          { status: 200 },
        );
      }
      if (u.includes('.well-known/openid-configuration')) {
        return new Response(JSON.stringify({ device_authorization_endpoint: 'https://oidc.example.test/device', token_endpoint: 'https://oidc.example.test/token' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          device_code: `dc-${Math.random()}`,
          user_code: 'ABCD-1234',
          verification_uri: 'https://verify.example.test',
          expires_in: 300,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await startDaytonaConnect({ clientIpHash: 'ip-hash-1' });
    await startDaytonaConnect({ clientIpHash: 'ip-hash-1' });
    await expect(startDaytonaConnect({ clientIpHash: 'ip-hash-1' })).rejects.toMatchObject({
      code: 'DAYTONA_TOO_MANY_FLOWS',
      httpStatus: 429,
    });
  });

  test('reapExpiredDaytonaConnectFlowsOnce revokes unclaimed expired flow keys and scrubs ciphertext', async () => {
    const flowId = '99999999-8888-7777-6666-555555555555';
    const enc = encryptDaytonaApiKey(flowId, 'dtn_unclaimed_key_1234567890');
    flowsTable.set(flowId, {
      flowId,
      deviceCode: 'dc-exp',
      userCode: 'uc-exp',
      verificationUriComplete: 'https://v',
      status: 'approved',
      encryptedApiKey: enc.encryptedApiKey,
      encryptionIv: enc.encryptionIv,
      encryptionTag: enc.encryptionTag,
      daytonaKeyName: 'kortix-app-flow-unclaimed',
      daytonaOrgId: 'org-exp-1',
      daytonaRegion: 'eu',
      claimToken: 'unclaimed-tok',
      clientIpHash: null,
      terminalErrorCode: null,
      terminalErrorMessage: null,
      terminalErrorStatus: null,
      expiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 1_000_000),
      updatedAt: new Date(Date.now() - 1_000_000),
    });

    const deletedUrls: string[] = [];
    global.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletedUrls.push(String(url));
        return new Response(null, { status: 204 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const swept = await reapExpiredDaytonaConnectFlowsOnce();
    expect(swept.expired).toBe(1);
    expect(swept.keysRevoked).toBe(1);
    expect(deletedUrls[0]).toContain('/api-keys/kortix-app-flow-unclaimed');
    expect(flowsTable.get(flowId)?.status).toBe('expired');
    expect(flowsTable.get(flowId)?.encryptedApiKey).toBeNull();
  });

  test('/v1/onboarding sits in the strict 30/min public-edge rate-limit bucket', async () => {
    const app = new Hono();
    app.use('*', createPublicEdgeRateLimitMiddleware());
    app.post('/v1/onboarding/daytona/start', (c) => c.json({ ok: true }));

    const res = await app.request('/v1/onboarding/daytona/start', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.55' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('30');
  });

  test('Milestone 3c: slow signup (>15m, <60m), idempotent same-user re-claim, cross-user single-use rejection, and already-connected user immunity', async () => {
    const flowId = '11111111-1111-4111-8111-111111111111';
    flowsTable.set(flowId, {
      flowId,
      deviceCode: 'dc-slow',
      userCode: 'SLOW-0001',
      verificationUriComplete: 'https://verify.example.test?user_code=SLOW-0001',
      status: 'pending',
      encryptedApiKey: null,
      encryptionIv: null,
      encryptionTag: null,
      daytonaKeyName: null,
      daytonaOrgId: null,
      daytonaRegion: null,
      claimToken: null,
      clientIpHash: null,
      terminalErrorCode: null,
      terminalErrorMessage: null,
      terminalErrorStatus: null,
      expiresAt: new Date(Date.now() + 600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    global.fetch = mock(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/config')) {
        return new Response(
          JSON.stringify({ oidc: { cli: { clientId: 'cid', issuer: 'https://oidc.example.test' } } }),
          { status: 200 },
        );
      }
      if (u.includes('.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({ device_authorization_endpoint: 'https://oidc.example.test/device', token_endpoint: 'https://oidc.example.test/token' }),
          { status: 200 },
        );
      }
      if (u.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 'jwt_000000000000' }), { status: 200 });
      }
      if (u.endsWith('/organizations')) {
        return new Response(
          JSON.stringify([{ id: 'org-slow-1', personal: true, defaultRegionId: 'eu', suspended: false }]),
          { status: 200 },
        );
      }
      if (u.includes('/api-keys')) {
        return new Response(
          JSON.stringify({ value: 'dtn_000000000000000000000000', name: 'kortix-app-flow-slow' }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ state: 'active' }), { status: 200 });
    }) as unknown as typeof fetch;

    const approved = await pollDaytonaConnect(flowId);
    expect(approved.status).toBe('approved');
    if (approved.status !== 'approved') throw new Error('expected approved');

    // Verify >=256 bits of entropy (32 bytes base64url = 43 chars)
    expect(approved.claimToken.length).toBeGreaterThanOrEqual(43);

    // Verify server extended claim expiry beyond 15m (default 60m) so a 25-minute signup still succeeds
    const storedFlow = flowsTable.get(flowId)!;
    expect(storedFlow.expiresAt.getTime() - Date.now()).toBeGreaterThan(25 * 60_000);

    // 1. First claim (e.g. inside /auth/callback during Google OAuth redirect) succeeds
    const userA = '00000000-0000-4000-8000-0000000000a1';
    const firstClaim = await claimDaytonaConnect(userA, approved.claimToken);
    expect(firstClaim.connected).toBe(true);
    expect(firstClaim.orgId).toBe('org-slow-1');

    // 2. Second claim by SAME user (e.g. post-auth DaytonaOnboardingGate or second tab) is IDEMPOTENT (200)
    const secondClaim = await claimDaytonaConnect(userA, approved.claimToken);
    expect(secondClaim.connected).toBe(true);
    expect(secondClaim.orgId).toBe('org-slow-1');

    // 3. Replay by a DIFFERENT user is strictly rejected (409 single-use)
    const userB = '00000000-0000-4000-8000-0000000000b2';
    await expect(claimDaytonaConnect(userB, approved.claimToken)).rejects.toMatchObject({
      httpStatus: 409,
    });

    // 4. Already-connected userA presenting a stale/expired claimToken is NEVER asked to sign in again
    await expect(claimDaytonaConnect(userA, 'stale_expired_token_000000000000')).resolves.toMatchObject({
      connected: true,
      orgId: 'org-slow-1',
    });

    // 5. Unconnected userB presenting an expired claimToken gets explicit 410
    await expect(claimDaytonaConnect(userB, 'stale_expired_token_000000000000')).rejects.toMatchObject({
      httpStatus: 410,
    });
  });

  test('Milestone 3c: email-verification path resumes same WorkOS approval once Daytona email is confirmed', async () => {
    const flowId = '22222222-2222-4222-8222-222222222222';
    flowsTable.set(flowId, {
      flowId,
      deviceCode: 'dc-email',
      userCode: 'MAIL-0001',
      verificationUriComplete: 'https://verify.example.test?user_code=MAIL-0001',
      status: 'pending',
      encryptedApiKey: null,
      encryptionIv: null,
      encryptionTag: null,
      daytonaKeyName: null,
      daytonaOrgId: null,
      daytonaRegion: null,
      claimToken: null,
      clientIpHash: null,
      terminalErrorCode: null,
      terminalErrorMessage: null,
      terminalErrorStatus: null,
      expiresAt: new Date(Date.now() + 300_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let emailVerified = false;
    let workosTokenCalls = 0;

    global.fetch = mock(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/config')) {
        return new Response(
          JSON.stringify({ oidc: { cli: { clientId: 'cid', issuer: 'https://oidc.example.test' } } }),
          { status: 200 },
        );
      }
      if (u.includes('.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({ device_authorization_endpoint: 'https://oidc.example.test/device', token_endpoint: 'https://oidc.example.test/token' }),
          { status: 200 },
        );
      }
      if (u.endsWith('/token')) {
        workosTokenCalls += 1;
        return new Response(JSON.stringify({ access_token: 'jwt_000000000001' }), { status: 200 });
      }
      if (u.endsWith('/organizations')) {
        return new Response(
          JSON.stringify([
            {
              id: 'org-mail-1',
              personal: true,
              defaultRegionId: 'eu',
              suspended: !emailVerified,
              suspensionReason: emailVerified ? null : 'Please verify your email address',
            },
          ]),
          { status: 200 },
        );
      }
      if (u.includes('/api-keys')) {
        return new Response(
          JSON.stringify({ value: 'dtn_000000000000000000000001', name: 'kortix-app-flow-mail' }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ state: 'active' }), { status: 200 });
    }) as unknown as typeof fetch;

    // Poll 1: user approved WorkOS before confirming Daytona email -> returns `email_verification_required` (not expired!)
    const poll1 = await pollDaytonaConnect(flowId);
    expect(poll1).toMatchObject({
      status: 'email_verification_required',
      errorCode: 'DAYTONA_EMAIL_UNVERIFIED',
    });
    expect(flowsTable.get(flowId)?.status).toBe('pending');
    expect(workosTokenCalls).toBe(1);

    // User clicks verification link in Daytona email -> Poll 2 ("Continue") succeeds without calling WorkOS /token again!
    emailVerified = true;
    const poll2 = await pollDaytonaConnect(flowId);
    expect(poll2).toMatchObject({
      status: 'approved',
      orgId: 'org-mail-1',
      region: 'eu',
    });
    expect(workosTokenCalls).toBe(1);
  });
});
