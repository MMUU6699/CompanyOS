import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Daytona } from '@daytonaio/sdk';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import {
  accountMembers,
  daytonaConnectFlows,
  sandboxes,
  sessionSandboxes,
  userDaytonaCredentials,
} from '@kortix/db';
import { config } from '../config';
import { logger } from '../lib/logger';
import { db, hasDatabase } from '../shared/db';
import { configuredTimeoutMs } from '../shared/with-timeout';
import {
  DAYTONA_HUMAN_ERROR_COPY as HUMAN_ERROR_COPY,
  DaytonaAllSandboxesBusyError,
  DaytonaNotConnectedError,
  DaytonaOrgSuspendedError,
  DaytonaReconnectRequiredError,
  DaytonaStructuredError,
  classifyDaytonaError,
  humanMessageForDaytonaCode,
  isDaytonaAllSandboxesBusyError,
  isDaytonaNotConnectedError,
  isDaytonaOrgSuspendedError,
  isDaytonaReconnectRequiredError,
  isDaytonaStructuredError,
  sanitizeStoredDaytonaError,
  type ClassifiedDaytonaError,
  type DaytonaErrorCode,
  type DaytonaOnboardingErrorCode,
} from '../shared/daytona-errors';
import {
  DEFAULT_CPU,
  DEFAULT_DISK_GB,
  DEFAULT_MEMORY_GB,
  KORTIX_ENTRYPOINT,
} from '../snapshots/build-context';
import {
  SnapshotStillBuildingError,
} from '../platform/providers/contract';
import {
  decryptDaytonaApiKey,
  encryptDaytonaApiKey,
} from './daytona-crypto';

export type UserDaytonaSnapshotStatus = 'pending' | 'pulling' | 'active' | 'inactive' | 'failed';

export {
  DaytonaAllSandboxesBusyError,
  DaytonaNotConnectedError,
  DaytonaOrgSuspendedError,
  DaytonaReconnectRequiredError,
  DaytonaStructuredError,
  classifyDaytonaError,
  humanMessageForDaytonaCode,
  isDaytonaAllSandboxesBusyError,
  isDaytonaNotConnectedError,
  isDaytonaOrgSuspendedError,
  isDaytonaReconnectRequiredError,
  isDaytonaStructuredError,
  sanitizeStoredDaytonaError,
  type ClassifiedDaytonaError,
  type DaytonaErrorCode,
  type DaytonaOnboardingErrorCode,
};

export interface UserDaytonaContext {
  userId: string;
  apiKey: string;
  daytonaOrgId: string;
  daytonaRegion: string;
  snapshotName: string | null;
  snapshotStatus: UserDaytonaSnapshotStatus;
  client: Daytona;
}

const DAYTONA_HTTP_TIMEOUT_MS = configuredTimeoutMs('KORTIX_DAYTONA_CALL_TIMEOUT_MS', 20_000, 1_000);
const DAYTONA_SNAPSHOT_CREATE_TIMEOUT_MS = configuredTimeoutMs(
  'KORTIX_DAYTONA_SNAPSHOT_CREATE_TIMEOUT_MS',
  65_000,
  15_000,
);
const DAYTONA_SNAPSHOT_PULL_GRACE_MS = 8 * 60_000;
const USER_CLIENT_CACHE_TTL_MS = 5 * 60_000;
const USER_CLIENT_CACHE_MAX = 500;
const EXTERNAL_OWNER_CACHE_TTL_MS = 10 * 60_000;
const EXTERNAL_OWNER_CACHE_MAX = 2_000;
const ACCOUNT_OWNER_CACHE_TTL_MS = 5 * 60_000;
const SNAPSHOT_ACTIVE_VERIFY_TTL_MS = 2 * 60_000;
const OIDC_CONFIG_CACHE_TTL_MS = 15 * 60_000;

const REQUIRED_DAYTONA_KEY_PERMISSIONS = [
  'write:sandboxes',
  'delete:sandboxes',
  'write:snapshots',
  'delete:snapshots',
  'read:limits',
] as const;

// ─── LRU Caches ──────────────────────────────────────────────────────────────

const userContextCache = new Map<string, { value: UserDaytonaContext; expiresAt: number }>();
const externalOwnerCache = new Map<string, { userId: string; orgId?: string; expiresAt: number }>();
const accountOwnerCache = new Map<string, { userId: string | null; expiresAt: number }>();
const verifiedActiveSnapshotCache = new Map<string, number>(); // `${orgId}:${snapshotName}` -> verifiedAtMs
const ensureSnapshotInFlight = new Map<string, Promise<EnsureUserSnapshotResult>>();
const pollFlowInFlight = new Map<string, Promise<PollDaytonaConnectResult>>();
const flowTerminalErrorCache = new Map<
  string,
  { code: DaytonaOnboardingErrorCode; message: string; httpStatus: number; expiresAt: number }
>();

function lruSet<K, V>(map: Map<K, V>, key: K, val: V, maxSize: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

export function daytonaApiBaseUrl(): string {
  return (config.DAYTONA_SERVER_URL || 'https://app.daytona.io/api').replace(/\/+$/, '');
}

export function invalidateUserDaytonaCache(userId: string): void {
  const existing = userContextCache.get(userId);
  if (existing) {
    for (const k of verifiedActiveSnapshotCache.keys()) {
      if (k.startsWith(`${existing.value.daytonaOrgId}:`)) {
        verifiedActiveSnapshotCache.delete(k);
      }
    }
  }
  userContextCache.delete(userId);
}

export function rememberExternalIdOwner(externalId: string, userId: string, orgId?: string): void {
  lruSet(
    externalOwnerCache,
    externalId,
    { userId, orgId, expiresAt: Date.now() + EXTERNAL_OWNER_CACHE_TTL_MS },
    EXTERNAL_OWNER_CACHE_MAX,
  );
}

export function isDaytonaCredentialRejectedStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export function isDaytonaCredentialRejectedError(err: unknown): boolean {
  const status =
    (err as { status?: number; statusCode?: number; response?: { status?: number } })?.status ??
    (err as { statusCode?: number })?.statusCode ??
    (err as { response?: { status?: number } })?.response?.status;
  if (status === 401) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('invalid credentials') ||
    msg.includes('invalid api key') ||
    msg.includes('unauthorized') ||
    msg.includes('api key is revoked') ||
    msg.includes('401')
  );
}

// ─── WorkOS OIDC Discovery (Dynamic from GET /api/config) ───────────────────

interface DaytonaWorkosOidcConfig {
  clientId: string;
  issuer: string;
  audience: string | null;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
}

let oidcCache: { value: DaytonaWorkosOidcConfig; expiresAt: number } | null = null;

export async function getDaytonaWorkosOidcConfig(): Promise<DaytonaWorkosOidcConfig> {
  if (oidcCache && oidcCache.expiresAt > Date.now()) {
    return oidcCache.value;
  }
  const base = daytonaApiBaseUrl();
  const cfgRes = await fetch(`${base}/config`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
  });
  if (!cfgRes.ok) {
    throw new Error(`Daytona /config failed with HTTP ${cfgRes.status}`);
  }
  const cfg = (await cfgRes.json()) as {
    oidc?: {
      issuer?: string;
      audience?: string;
      cli?: { issuer?: string; clientId?: string };
    };
  };
  const clientId = cfg.oidc?.cli?.clientId?.trim();
  const issuer = (cfg.oidc?.cli?.issuer || cfg.oidc?.issuer || '').trim();
  const audience = cfg.oidc?.audience?.trim() || null;
  if (!clientId || !issuer) {
    throw new Error('Daytona /config missing oidc.cli.clientId or oidc.issuer');
  }

  const discRes = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
  });
  if (!discRes.ok) {
    throw new Error(`WorkOS OIDC discovery failed with HTTP ${discRes.status}`);
  }
  const disc = (await discRes.json()) as {
    authorization_endpoint?: string;
    token_endpoint?: string;
    device_authorization_endpoint?: string;
  };
  const tokenEndpoint = disc.token_endpoint?.trim();
  const deviceAuthorizationEndpoint =
    disc.device_authorization_endpoint?.trim() ||
    (disc.authorization_endpoint ? `${disc.authorization_endpoint.replace(/\/+$/, '')}/device` : '');
  if (!tokenEndpoint || !deviceAuthorizationEndpoint) {
    throw new Error('WorkOS OIDC discovery missing device_authorization_endpoint or token_endpoint');
  }

  const value: DaytonaWorkosOidcConfig = {
    clientId,
    issuer,
    audience,
    deviceAuthorizationEndpoint,
    tokenEndpoint,
  };
  oidcCache = { value, expiresAt: Date.now() + OIDC_CONFIG_CACHE_TTL_MS };
  return value;
}

// ─── GHCR Pinned Snapshot Reference & Lifecycle ─────────────────────────────

export function getPinnedGhcrSandboxImage(): string | null {
  const raw = config.KORTIX_SANDBOX_GHCR_IMAGE?.trim();
  if (!raw) return null;
  if (raw.endsWith(':latest')) {
    throw new Error('KORTIX_SANDBOX_GHCR_IMAGE must use an immutable pinned tag or digest, never :latest');
  }
  if (!raw.includes(':') && !raw.includes('@sha256:')) {
    throw new Error('KORTIX_SANDBOX_GHCR_IMAGE must include an explicit tag or @sha256 digest');
  }
  return raw;
}

export function deriveSnapshotNameForImage(imageRef: string): string {
  // Daytona snapshot names allow letters, digits, dots, colons, slashes, and dashes.
  const digestIdx = imageRef.indexOf('@sha256:');
  if (digestIdx !== -1) {
    const digest = imageRef.slice(digestIdx + '@sha256:'.length, digestIdx + '@sha256:'.length + 12);
    return `kortix-sandbox-${digest}`;
  }
  const lastColon = imageRef.lastIndexOf(':');
  const rawTag = lastColon > imageRef.lastIndexOf('/') ? imageRef.slice(lastColon + 1) : '';
  const safeTag = rawTag.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48);
  if (safeTag) {
    return `kortix-sandbox-${safeTag}`;
  }
  const hash = createHash('sha256').update(imageRef).digest('hex').slice(0, 12);
  return `kortix-sandbox-${hash}`;
}

function mapDaytonaSnapshotState(raw: string | undefined): UserDaytonaSnapshotStatus {
  const s = (raw || '').toLowerCase();
  if (s === 'active') return 'active';
  if (s === 'inactive') return 'inactive';
  if (s === 'pending') return 'pending';
  if (
    s === 'pulling' ||
    s === 'building' ||
    s === 'creating' ||
    s === 'snapshotting' ||
    s === 'activating'
  ) {
    return 'pulling';
  }
  if (s === 'error' || s === 'build_failed' || s === 'removing') return 'failed';
  return 'pulling';
}

export interface EnsureUserSnapshotResult {
  snapshotName: string;
  snapshotStatus: UserDaytonaSnapshotStatus;
  snapshotErrorCode: DaytonaOnboardingErrorCode | null;
  snapshotError: string | null;
  reconnectRequired?: boolean;
}

async function updateUserSnapshotDbState(
  userId: string | undefined,
  patch: {
    snapshotName?: string;
    snapshotStatus: UserDaytonaSnapshotStatus;
    snapshotError?: string | null;
  },
): Promise<void> {
  if (!userId || !hasDatabase) return;
  try {
    await db
      .update(userDaytonaCredentials)
      .set({
        ...(patch.snapshotName !== undefined ? { snapshotName: patch.snapshotName } : {}),
        snapshotStatus: patch.snapshotStatus,
        snapshotError: patch.snapshotError ?? null,
        updatedAt: new Date(),
      })
      .where(eq(userDaytonaCredentials.userId, userId));
    const cached = userContextCache.get(userId);
    if (cached) {
      if (patch.snapshotName !== undefined) cached.value.snapshotName = patch.snapshotName;
      cached.value.snapshotStatus = patch.snapshotStatus;
    }
  } catch (err) {
    console.warn(
      '[daytona-onboarding] failed to update snapshot state in DB:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Ensure the pinned GHCR Kortix sandbox snapshot exists and is active/pulling
 * inside a user's own Daytona organization. Single-flight per `daytonaOrgId`.
 */
export function ensureUserSnapshot(opts: {
  userId?: string;
  apiKey: string;
  daytonaOrgId: string;
  daytonaRegion: string;
}): Promise<EnsureUserSnapshotResult> {
  const imageRef = getPinnedGhcrSandboxImage();
  if (!imageRef) {
    void updateUserSnapshotDbState(opts.userId, {
      snapshotStatus: 'failed',
      snapshotError: 'DAYTONA_SNAPSHOT_FAILED',
    });
    return Promise.resolve({
      snapshotName: '',
      snapshotStatus: 'failed',
      snapshotErrorCode: 'DAYTONA_SNAPSHOT_FAILED',
      snapshotError: HUMAN_ERROR_COPY.DAYTONA_SNAPSHOT_FAILED,
      reconnectRequired: false,
    });
  }
  const snapshotName = deriveSnapshotNameForImage(imageRef);
  const flightKey = `${opts.daytonaOrgId}:${snapshotName}`;
  const existingFlight = ensureSnapshotInFlight.get(flightKey);
  if (existingFlight) return existingFlight;

  const task = (async (): Promise<EnsureUserSnapshotResult> => {
    const base = daytonaApiBaseUrl();
    const authHeaders = {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: 'application/json',
    };

    try {
      const getRes = await fetch(`${base}/snapshots/${encodeURIComponent(snapshotName)}`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
      });

      if (isDaytonaCredentialRejectedStatus(getRes.status)) {
        if (opts.userId) invalidateUserDaytonaCache(opts.userId);
        await updateUserSnapshotDbState(opts.userId, {
          snapshotName,
          snapshotStatus: 'failed',
          snapshotError: 'DAYTONA_RECONNECT_REQUIRED',
        });
        throw new DaytonaReconnectRequiredError();
      }

      if (getRes.ok) {
        const snap = (await getRes.json()) as {
          id: string;
          name: string;
          state?: string;
          errorReason?: string;
        };
        const mapped = mapDaytonaSnapshotState(snap.state);

        if (mapped === 'active') {
          verifiedActiveSnapshotCache.set(flightKey, Date.now());
          await updateUserSnapshotDbState(opts.userId, {
            snapshotName,
            snapshotStatus: 'active',
            snapshotError: null,
          });
          return {
            snapshotName,
            snapshotStatus: 'active',
            snapshotErrorCode: null,
            snapshotError: null,
            reconnectRequired: false,
          };
        }

        if (mapped === 'inactive') {
          verifiedActiveSnapshotCache.delete(flightKey);
          console.log(
            `[daytona-onboarding] activating inactive snapshot ${snapshotName} (${snap.id}) in org ${opts.daytonaOrgId}`,
          );
          const actRes = await fetch(`${base}/snapshots/${encodeURIComponent(snap.id)}/activate`, {
            method: 'POST',
            headers: authHeaders,
            signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
          });
          if (isDaytonaCredentialRejectedStatus(actRes.status)) {
            if (opts.userId) invalidateUserDaytonaCache(opts.userId);
            throw new DaytonaReconnectRequiredError();
          }
          if (actRes.ok) {
            await updateUserSnapshotDbState(opts.userId, {
              snapshotName,
              snapshotStatus: 'pulling',
              snapshotError: null,
            });
            return {
              snapshotName,
              snapshotStatus: 'pulling',
              snapshotErrorCode: null,
              snapshotError: null,
              reconnectRequired: false,
            };
          }
          const actErr = await actRes.text().catch(() => '');
          console.warn(
            `[daytona-onboarding] activate snapshot failed (HTTP ${actRes.status}): ${actErr.slice(0, 300)}`,
          );
          const classified = classifyDaytonaError(actRes.status, actErr);
          await updateUserSnapshotDbState(opts.userId, {
            snapshotName,
            snapshotStatus: 'failed',
            snapshotError: classified.code,
          });
          return {
            snapshotName,
            snapshotStatus: 'failed',
            snapshotErrorCode: classified.code,
            snapshotError: classified.message,
            reconnectRequired: classified.reconnectRequired,
          };
        }

        if (mapped === 'pending' || mapped === 'pulling') {
          await updateUserSnapshotDbState(opts.userId, {
            snapshotName,
            snapshotStatus: mapped,
            snapshotError: null,
          });
          return {
            snapshotName,
            snapshotStatus: mapped,
            snapshotErrorCode: null,
            snapshotError: null,
            reconnectRequired: false,
          };
        }

        // Previous snapshot errored: delete it cleanly and recreate once below.
        console.warn(
          `[daytona-onboarding] deleting errored snapshot ${snapshotName} (${snap.id}, reason=${snap.errorReason ?? 'unknown'}) in org ${opts.daytonaOrgId}`,
        );
        await fetch(`${base}/snapshots/${encodeURIComponent(snap.id)}`, {
          method: 'DELETE',
          headers: authHeaders,
          signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
        }).catch(() => {});
      } else if (getRes.status !== 404) {
        const body = await getRes.text().catch(() => '');
        console.warn(
          `[daytona-onboarding] snapshot lookup failed (HTTP ${getRes.status}): ${body.slice(0, 300)}`,
        );
        const classified = classifyDaytonaError(getRes.status, body);
        await updateUserSnapshotDbState(opts.userId, {
          snapshotName,
          snapshotStatus: 'failed',
          snapshotError: classified.code,
        });
        return {
          snapshotName,
          snapshotStatus: 'failed',
          snapshotErrorCode: classified.code,
          snapshotError: classified.message,
          reconnectRequired: classified.reconnectRequired,
        };
      }

      const targetRegion = opts.daytonaRegion || config.DAYTONA_TARGET || 'eu';
      const createPayload = JSON.stringify({
        name: snapshotName,
        imageName: imageRef,
        entrypoint: [KORTIX_ENTRYPOINT],
        cpu: DEFAULT_CPU,
        memory: DEFAULT_MEMORY_GB,
        disk: DEFAULT_DISK_GB,
        sandboxClass: 'container',
        regionId: targetRegion,
      });

      const postCreateSnapshot = () =>
        fetch(`${base}/snapshots`, {
          method: 'POST',
          headers: {
            ...authHeaders,
            'Content-Type': 'application/json',
          },
          body: createPayload,
          signal: AbortSignal.timeout(DAYTONA_SNAPSHOT_CREATE_TIMEOUT_MS),
        });

      // Create snapshot in the user's Daytona org from the public pinned GHCR image.
      console.log(
        `[daytona-onboarding] creating snapshot ${snapshotName} from ${imageRef} in org ${opts.daytonaOrgId} (region=${targetRegion}, timeout=${DAYTONA_SNAPSHOT_CREATE_TIMEOUT_MS}ms)`,
      );
      let createRes: Response;
      try {
        createRes = await postCreateSnapshot();
      } catch (createErr) {
        const createClassified = classifyDaytonaError(
          createErr,
          createErr instanceof Error ? createErr.message : String(createErr),
        );
        // Daytona may accept POST /snapshots asynchronously while the HTTP response
        // times out during initial manifest fetch. Treat timeouts as pulling so
        // /status continues polling cleanly for up to 8 minutes instead of falsely failing.
        if (createClassified.code === 'DAYTONA_TIMEOUT') {
          console.warn(
            `[daytona-onboarding] POST /snapshots timed out for ${snapshotName} in org ${opts.daytonaOrgId}; treating as pulling`,
          );
          await updateUserSnapshotDbState(opts.userId, {
            snapshotName,
            snapshotStatus: 'pulling',
            snapshotError: null,
          });
          return {
            snapshotName,
            snapshotStatus: 'pulling',
            snapshotErrorCode: null,
            snapshotError: null,
            reconnectRequired: false,
          };
        }
        throw createErr;
      }

      if (isDaytonaCredentialRejectedStatus(createRes.status)) {
        if (opts.userId) invalidateUserDaytonaCache(opts.userId);
        throw new DaytonaReconnectRequiredError();
      }

      if (createRes.ok || createRes.status === 409) {
        await updateUserSnapshotDbState(opts.userId, {
          snapshotName,
          snapshotStatus: 'pulling',
          snapshotError: null,
        });
        return {
          snapshotName,
          snapshotStatus: 'pulling',
          snapshotErrorCode: null,
          snapshotError: null,
          reconnectRequired: false,
        };
      }

      let errText = await createRes.text().catch(() => '');
      console.warn(
        `[daytona-onboarding] POST /snapshots failed (HTTP ${createRes.status}): ${errText.slice(0, 300)}`,
      );
      let classified = classifyDaytonaError(createRes.status, errText);

      // Self-heal for orgs connected before PATCH /default-region shipped:
      // attempt PATCH /organizations/:orgId/default-region with API key once, then retry POST /snapshots.
      if (classified.code === 'DAYTONA_REGION_REQUIRED' && opts.daytonaOrgId) {
        try {
          const regionToSet = await resolvePreferredSharedRegion(targetRegion);
          const patchRes = await fetch(
            `${base}/organizations/${encodeURIComponent(opts.daytonaOrgId)}/default-region`,
            {
              method: 'PATCH',
              headers: {
                ...authHeaders,
                'X-Daytona-Organization-ID': opts.daytonaOrgId,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ defaultRegionId: regionToSet }),
              signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
            },
          );
          if (patchRes.ok) {
            console.log(
              `[daytona-onboarding] self-healed defaultRegionId=${regionToSet} via PATCH for org ${opts.daytonaOrgId}; retrying POST /snapshots`,
            );
            createRes = await postCreateSnapshot();
            if (createRes.ok || createRes.status === 409) {
              await updateUserSnapshotDbState(opts.userId, {
                snapshotName,
                snapshotStatus: 'pulling',
                snapshotError: null,
              });
              return {
                snapshotName,
                snapshotStatus: 'pulling',
                snapshotErrorCode: null,
                snapshotError: null,
                reconnectRequired: false,
              };
            }
            errText = await createRes.text().catch(() => '');
            classified = classifyDaytonaError(createRes.status, errText);
          } else {
            console.warn(
              `[daytona-onboarding] API-key PATCH default-region returned HTTP ${patchRes.status}; reconnect required so user JWT can set defaultRegionId`,
            );
          }
        } catch (patchErr) {
          console.warn(
            '[daytona-onboarding] self-heal PATCH default-region threw:',
            patchErr instanceof Error ? patchErr.message : String(patchErr),
          );
        }
      }

      await updateUserSnapshotDbState(opts.userId, {
        snapshotName,
        snapshotStatus: 'failed',
        snapshotError: classified.code,
      });
      return {
        snapshotName,
        snapshotStatus: 'failed',
        snapshotErrorCode: classified.code,
        snapshotError: classified.message,
        reconnectRequired: classified.reconnectRequired,
      };
    } catch (err) {
      if (isDaytonaReconnectRequiredError(err)) throw err;
      const rawMsg = err instanceof Error ? err.message : String(err);
      console.warn('[daytona-onboarding] ensureUserSnapshot exception:', rawMsg);
      const classified = classifyDaytonaError(err, rawMsg);
      await updateUserSnapshotDbState(opts.userId, {
        snapshotName,
        snapshotStatus: 'failed',
        snapshotError: classified.code,
      });
      return {
        snapshotName,
        snapshotStatus: 'failed',
        snapshotErrorCode: classified.code,
        snapshotError: classified.message,
        reconnectRequired: classified.reconnectRequired,
      };
    }
  })().finally(() => {
    ensureSnapshotInFlight.delete(flightKey);
  });

  ensureSnapshotInFlight.set(flightKey, task);
  return task;
}

/**
 * Fast pre-flight check before `sandbox.create()` in a user's Daytona org:
 * returns immediately if recently verified active; otherwise pulls/activates
 * and waits up to `waitTimeoutMs` until Daytona marks it `active`.
 */
export async function ensureUserSnapshotActive(
  ctx: UserDaytonaContext,
  waitTimeoutMs = DAYTONA_SNAPSHOT_PULL_GRACE_MS,
  opts?: { onPulling?: (snapshotName: string) => void },
): Promise<{ snapshotName: string }> {
  const imageRef = getPinnedGhcrSandboxImage();
  if (!imageRef) {
    throw new Error('KORTIX_SANDBOX_GHCR_IMAGE is not configured');
  }
  const expectedName = deriveSnapshotNameForImage(imageRef);
  const cacheKey = `${ctx.daytonaOrgId}:${expectedName}`;
  const verifiedAt = verifiedActiveSnapshotCache.get(cacheKey);
  if (
    verifiedAt !== undefined &&
    Date.now() - verifiedAt < SNAPSHOT_ACTIVE_VERIFY_TTL_MS &&
    ctx.snapshotName === expectedName &&
    ctx.snapshotStatus === 'active'
  ) {
    return { snapshotName: expectedName };
  }

  const deadline = Date.now() + waitTimeoutMs;
  let notifiedPulling = false;
  const notifyPulling = (name: string) => {
    if (notifiedPulling) return;
    notifiedPulling = true;
    opts?.onPulling?.(name || expectedName);
  };

  let last = await ensureUserSnapshot({
    userId: ctx.userId,
    apiKey: ctx.apiKey,
    daytonaOrgId: ctx.daytonaOrgId,
    daytonaRegion: ctx.daytonaRegion,
  });

  while (
    last.snapshotStatus === 'pending' ||
    last.snapshotStatus === 'pulling' ||
    (last.snapshotStatus === 'failed' && last.snapshotErrorCode === 'DAYTONA_TIMEOUT')
  ) {
    notifyPulling(last.snapshotName);
    if (Date.now() >= deadline) {
      throw new SnapshotStillBuildingError(
        `Your private Daytona cloud computer image (${last.snapshotName || expectedName}) is still being prepared. Please retry in a few seconds.`,
      );
    }
    await new Promise((r) => setTimeout(r, 2_500));
    last = await ensureUserSnapshot({
      userId: ctx.userId,
      apiKey: ctx.apiKey,
      daytonaOrgId: ctx.daytonaOrgId,
      daytonaRegion: ctx.daytonaRegion,
    });
  }

  if (last.snapshotStatus === 'active') {
    return { snapshotName: last.snapshotName };
  }

  if (
    last.reconnectRequired ||
    last.snapshotErrorCode === 'DAYTONA_RECONNECT_REQUIRED' ||
    last.snapshotErrorCode === 'DAYTONA_REGION_REQUIRED'
  ) {
    throw new DaytonaReconnectRequiredError(last.snapshotError || undefined);
  }
  throw new DaytonaStructuredError(
    last.snapshotErrorCode || 'DAYTONA_SNAPSHOT_FAILED',
    last.snapshotError || HUMAN_ERROR_COPY.DAYTONA_SNAPSHOT_FAILED,
  );
}

// ─── Per-User Daytona Client Resolution (5-min LRU Cache) ───────────────────

export type DaytonaContextResolution =
  | { kind: 'user'; ctx: UserDaytonaContext }
  | { kind: 'not_connected'; userId?: string | null; reason?: string }
  | { kind: 'reconnect_required'; userId?: string | null; message: string; cause?: unknown }
  | { kind: 'error'; cause: unknown; message: string };

export async function resolveUserDaytonaContext(
  userId: string,
): Promise<DaytonaContextResolution> {
  if (!userId) {
    return { kind: 'not_connected', userId: null, reason: 'missing_user_id' };
  }
  if (!hasDatabase) {
    const err = new Error('Database unavailable while resolving Daytona credentials');
    return { kind: 'error', cause: err, message: err.message };
  }

  const cached = userContextCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return { kind: 'user', ctx: cached.value };
  }

  let rows: Array<typeof userDaytonaCredentials.$inferSelect>;
  try {
    rows = await db
      .select()
      .from(userDaytonaCredentials)
      .where(eq(userDaytonaCredentials.userId, userId))
      .limit(1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[daytona-onboarding] database error resolving user Daytona credentials', {
      userId,
      error: message,
    });
    return { kind: 'error', cause: err, message };
  }

  const row = rows[0];
  if (!row) {
    return { kind: 'not_connected', userId, reason: 'no_credentials' };
  }

  let apiKey: string;
  try {
    apiKey = decryptDaytonaApiKey(userId, {
      encryptedApiKey: row.encryptedApiKey,
      encryptionIv: row.encryptionIv,
      encryptionTag: row.encryptionTag,
    });
  } catch (err) {
    logger.error('[daytona-onboarding] failed to decrypt stored user Daytona API key', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: 'reconnect_required',
      userId,
      message: 'Your stored Daytona credentials could not be decrypted. Please reconnect Daytona.',
      cause: err,
    };
  }

  const client = new Daytona({
    apiKey,
    apiUrl: daytonaApiBaseUrl(),
    target: row.daytonaRegion || config.DAYTONA_TARGET || 'eu',
  });

  const ctx: UserDaytonaContext = {
    userId: row.userId,
    apiKey,
    daytonaOrgId: row.daytonaOrgId,
    daytonaRegion: row.daytonaRegion || config.DAYTONA_TARGET || 'eu',
    snapshotName: row.snapshotName ?? null,
    snapshotStatus: row.snapshotStatus,
    client,
  };

  lruSet(
    userContextCache,
    userId,
    { value: ctx, expiresAt: Date.now() + USER_CLIENT_CACHE_TTL_MS },
    USER_CLIENT_CACHE_MAX,
  );
  return { kind: 'user', ctx };
}

/**
 * Compatibility helper for onboarding status checks that only want the active
 * context or null when not connected. Propagates DB errors and decrypt failures
 * instead of silently returning null.
 */
export async function getUserDaytonaContext(userId: string): Promise<UserDaytonaContext | null> {
  const res = await resolveUserDaytonaContext(userId);
  if (res.kind === 'user') return res.ctx;
  if (res.kind === 'not_connected') return null;
  if (res.kind === 'reconnect_required') {
    throw new DaytonaReconnectRequiredError(res.message);
  }
  throw res.cause instanceof Error ? res.cause : new Error(res.message);
}

type AccountOwnerLookupResult =
  | { ok: true; userId: string | null }
  | { ok: false; cause: unknown; message: string };

async function resolveAccountOwnerUserId(accountId: string): Promise<AccountOwnerLookupResult> {
  if (!accountId) return { ok: true, userId: null };
  if (!hasDatabase) {
    const err = new Error('Database unavailable while resolving account owner');
    return { ok: false, cause: err, message: err.message };
  }
  const cached = accountOwnerCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, userId: cached.userId };
  }

  try {
    const rows = await db
      .select({ userId: accountMembers.userId })
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.accountRole, 'owner')))
      .limit(1);
    const ownerId = rows[0]?.userId ?? null;
    lruSet(
      accountOwnerCache,
      accountId,
      { userId: ownerId, expiresAt: Date.now() + ACCOUNT_OWNER_CACHE_TTL_MS },
      USER_CLIENT_CACHE_MAX,
    );
    return { ok: true, userId: ownerId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[daytona-onboarding] failed to resolve account owner', {
      accountId,
      error: message,
    });
    return { ok: false, cause: err, message };
  }
}

export async function resolveDaytonaContextForOwner(opts: {
  userId?: string | null;
  accountId?: string | null;
  sessionId?: string | null;
}): Promise<DaytonaContextResolution> {
  if (opts.userId) {
    const direct = await resolveUserDaytonaContext(opts.userId);
    if (direct.kind !== 'not_connected') return direct;
  }

  // Account-owner fallback is opt-in only via KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK.
  if (config.KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK && opts.accountId) {
    const owner = await resolveAccountOwnerUserId(opts.accountId);
    if (!owner.ok) {
      return { kind: 'error', cause: owner.cause, message: owner.message };
    }
    if (owner.userId && owner.userId !== opts.userId) {
      const ownerRes = await resolveUserDaytonaContext(owner.userId);
      if (ownerRes.kind === 'user') {
        logger.warn(
          '[daytona-onboarding] using account-owner Daytona key fallback (KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK=true)',
          {
            sessionId: opts.sessionId ?? null,
            requestedUserId: opts.userId ?? null,
            fallbackOwnerUserId: owner.userId,
            accountId: opts.accountId,
          },
        );
      }
      return ownerRes;
    }
  }

  return {
    kind: 'not_connected',
    userId: opts.userId ?? null,
    reason: opts.userId ? 'user_not_connected' : 'missing_session_owner',
  };
}

export async function resolveDaytonaContextForExternalId(
  externalId: string,
): Promise<DaytonaContextResolution> {
  if (!externalId) {
    return { kind: 'not_connected', reason: 'missing_external_id' };
  }
  if (!hasDatabase) {
    const err = new Error('Database unavailable while resolving sandbox owner');
    return { kind: 'error', cause: err, message: err.message };
  }

  const cached = externalOwnerCache.get(externalId);
  if (cached && cached.expiresAt > Date.now()) {
    const resolved = await resolveUserDaytonaContext(cached.userId);
    if (resolved.kind === 'user' && cached.orgId && resolved.ctx.daytonaOrgId !== cached.orgId) {
      externalOwnerCache.delete(externalId);
      return {
        kind: 'reconnect_required',
        userId: cached.userId,
        message:
          'This session belongs to a previous Daytona organization. Reconnect that Daytona account or start a new session.',
      };
    }
    return resolved;
  }

  let ownerUserId: string | null = null;
  let accountId: string | null = null;
  let orgId: string | undefined;
  let sessionId: string | null = null;

  try {
    const sessRows = await db
      .select({
        sandboxId: sessionSandboxes.sandboxId,
        accountId: sessionSandboxes.accountId,
        metadata: sessionSandboxes.metadata,
      })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.externalId, externalId))
      .limit(1);

    if (sessRows[0]) {
      const meta = (sessRows[0].metadata ?? {}) as Record<string, unknown>;
      sessionId = sessRows[0].sandboxId ?? null;
      accountId = sessRows[0].accountId ?? null;
      if (typeof meta.daytonaOwnerUserId === 'string' && meta.daytonaOwnerUserId) {
        ownerUserId = meta.daytonaOwnerUserId;
      } else if (typeof meta.provisionedBy === 'string' && meta.provisionedBy) {
        ownerUserId = meta.provisionedBy;
      }
      if (typeof meta.daytonaOrgId === 'string' && meta.daytonaOrgId) {
        orgId = meta.daytonaOrgId;
      }
    } else {
      const sbRows = await db
        .select({ accountId: sandboxes.accountId })
        .from(sandboxes)
        .where(eq(sandboxes.externalId, externalId))
        .limit(1);
      if (sbRows[0]) {
        accountId = sbRows[0].accountId ?? null;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[daytona-onboarding] database error resolving owner for externalId', {
      externalId,
      error: message,
    });
    return { kind: 'error', cause: err, message };
  }

  const resolved = await resolveDaytonaContextForOwner({
    userId: ownerUserId,
    accountId,
    sessionId: sessionId ?? externalId,
  });

  if (resolved.kind !== 'user') {
    return resolved;
  }

  // Never route a sandbox created in Org A to a key belonging to Org B.
  if (orgId && orgId !== resolved.ctx.daytonaOrgId) {
    return {
      kind: 'reconnect_required',
      userId: resolved.ctx.userId,
      message:
        'This session belongs to a previous Daytona organization. Reconnect that Daytona account or start a new session.',
    };
  }

  rememberExternalIdOwner(externalId, resolved.ctx.userId, resolved.ctx.daytonaOrgId);
  return resolved;
}

// ─── WorkOS Device Flow Onboarding Endpoints Logic ──────────────────────────

export interface StartDaytonaConnectResult {
  flowId: string;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

export async function startDaytonaConnect(): Promise<StartDaytonaConnectResult> {
  const oidc = await getDaytonaWorkosOidcConfig();
  const form = new URLSearchParams({
    client_id: oidc.clientId,
    scope: 'openid profile email offline_access',
  });
  if (oidc.audience) {
    form.set('audience', oidc.audience);
  }

  const res = await fetch(oidc.deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Daytona WorkOS device authorization failed (HTTP ${res.status}): ${bodyText.slice(0, 200)}`);
  }
  const dc = JSON.parse(bodyText) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!dc.device_code || !dc.user_code || !dc.verification_uri) {
    throw new Error('Daytona WorkOS device authorization returned incomplete response');
  }

  const flowId = randomUUID();
  const expiresIn = Math.max(60, Math.min(600, Number(dc.expires_in ?? 300)));
  const interval = Math.max(2, Number(dc.interval ?? 5));
  const verificationUriComplete =
    dc.verification_uri_complete ||
    `${dc.verification_uri}?user_code=${encodeURIComponent(dc.user_code)}`;
  // Match WorkOS's real expires_in TTL so expired codes transition cleanly to 'expired'.
  const expiresAt = new Date(Date.now() + expiresIn * 1_000);

  await db.insert(daytonaConnectFlows).values({
    flowId,
    deviceCode: dc.device_code,
    userCode: dc.user_code,
    verificationUriComplete,
    status: 'pending',
    expiresAt,
  });

  // Best-effort cleanup of old expired flows (> 1h past expiry).
  const pruneBefore = new Date(Date.now() - 60 * 60_000);
  void db
    .delete(daytonaConnectFlows)
    .where(lt(daytonaConnectFlows.expiresAt, pruneBefore))
    .catch(() => {});

  return {
    flowId,
    verificationUri: dc.verification_uri,
    verificationUriComplete,
    userCode: dc.user_code,
    expiresIn,
    interval,
  };
}

export type PollDaytonaConnectResult =
  | { status: 'pending'; slowDown?: boolean }
  | { status: 'expired' }
  | { status: 'email_verification_required'; errorCode: 'DAYTONA_EMAIL_UNVERIFIED'; message: string }
  | { status: 'approved'; claimToken: string; orgId: string; region: string }
  | { status: 'claimed'; orgId: string | null; region: string | null };

/**
 * Resolve the preferred shared region from Daytona's public `GET /shared-regions`
 * endpoint (`RegionsApi.listSharedRegions`): prefers `eu`, falls back to `us`,
 * then the first available shared region ID.
 */
export async function resolvePreferredSharedRegion(preferred?: string | null): Promise<string> {
  const base = daytonaApiBaseUrl();
  const desired = (preferred || config.DAYTONA_TARGET || 'eu').trim().toLowerCase();
  try {
    const regRes = await fetch(`${base}/shared-regions`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
    });
    if (regRes.ok) {
      const regions = (await regRes.json()) as Array<{ id?: string; name?: string }>;
      if (Array.isArray(regions) && regions.length > 0) {
        const byDesired = regions.find(
          (r) =>
            r.id?.toLowerCase() === desired ||
            r.name?.toLowerCase() === desired,
        );
        const byEu = regions.find(
          (r) => r.id?.toLowerCase() === 'eu' || r.name?.toLowerCase() === 'eu',
        );
        const byUs = regions.find(
          (r) => r.id?.toLowerCase() === 'us' || r.name?.toLowerCase() === 'us',
        );
        const pick = byDesired || byEu || byUs || regions[0];
        if (pick?.id) return String(pick.id);
        if (pick?.name) return String(pick.name);
      }
    }
  } catch (err) {
    console.warn(
      '[daytona-onboarding] GET /shared-regions failed, falling back to default:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return desired || 'eu';
}

export async function ensureDefaultRegionOnOrg(
  jwt: string,
  orgId: string,
  currentRegionId: string | null | undefined,
): Promise<string> {
  if (currentRegionId && currentRegionId.trim()) {
    return currentRegionId.trim();
  }
  const base = daytonaApiBaseUrl();
  const chosen = await resolvePreferredSharedRegion(config.DAYTONA_TARGET || 'eu');

  // Verified against @daytona/api-client OrganizationsApi.setOrganizationDefaultRegion:
  // PATCH /organizations/{organizationId}/default-region with { defaultRegionId }.
  const patchRes = await fetch(
    `${base}/organizations/${encodeURIComponent(orgId)}/default-region`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Daytona-Organization-ID': orgId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ defaultRegionId: chosen }),
      signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
    },
  );
  if (!patchRes.ok) {
    const errBody = await patchRes.text().catch(() => '');
    console.error(
      `[daytona-onboarding] PATCH /organizations/${orgId}/default-region (${chosen}) failed (HTTP ${patchRes.status}): ${errBody.slice(0, 300)}`,
    );
    throw new DaytonaStructuredError(
      'DAYTONA_REGION_REQUIRED',
      HUMAN_ERROR_COPY.DAYTONA_REGION_REQUIRED,
      502,
    );
  }
  console.log(
    `[daytona-onboarding] set defaultRegionId=${chosen} on org ${orgId} via PATCH /default-region`,
  );
  return chosen;
}

interface DaytonaOrgSummary {
  id: string;
  personal?: boolean;
  suspended?: boolean;
  suspensionReason?: string | null;
  defaultRegionId?: string | null;
}

/**
 * Fetch organizations for a newly authorized Daytona WorkOS JWT, retrying up to
 * 6 times (1s apart) when Daytona's async `UserEvents.CREATED` handler has not
 * yet finished creating the brand-new user's personal organization.
 */
export async function fetchOrganizationsWithPropagationRetry(
  jwt: string,
  maxAttempts = 6,
  delayMs = 1_000,
): Promise<DaytonaOrgSummary[]> {
  const base = daytonaApiBaseUrl();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const orgsRes = await fetch(`${base}/organizations`, {
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
    });
    if (!orgsRes.ok) {
      const errBody = await orgsRes.text().catch(() => '');
      console.warn(
        `[daytona-onboarding] GET /organizations failed (HTTP ${orgsRes.status}, attempt ${attempt}/${maxAttempts}): ${errBody.slice(0, 200)}`,
      );
      if (attempt < maxAttempts && (orgsRes.status >= 500 || orgsRes.status === 429)) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      const classified = classifyDaytonaError(orgsRes.status, errBody);
      throw new DaytonaStructuredError(classified.code, classified.message, 502);
    }
    const orgs = (await orgsRes.json()) as DaytonaOrgSummary[];
    if (Array.isArray(orgs) && orgs.length > 0) {
      return orgs;
    }
    if (attempt < maxAttempts) {
      console.log(
        `[daytona-onboarding] GET /organizations returned empty array for new account (attempt ${attempt}/${maxAttempts}); waiting ${delayMs}ms for personal org provisioning`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return [];
}

async function cleanupStaleKortixApiKeys(jwt: string, orgId: string): Promise<void> {
  const base = daytonaApiBaseUrl();
  try {
    const listRes = await fetch(`${base}/api-keys`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Daytona-Organization-ID': orgId,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
    });
    if (!listRes.ok) return;
    const keys = (await listRes.json()) as Array<{ name?: string; createdAt?: string }>;
    if (!Array.isArray(keys)) return;
    const kortixKeys = keys
      .filter((k) => typeof k.name === 'string' && k.name.startsWith('kortix-app-'))
      .sort((a, b) => Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0'));
    // Keep the 2 most recent Kortix keys and prune older stale ones from prior reconnects.
    const stale = kortixKeys.slice(2);
    for (const oldKey of stale) {
      if (!oldKey.name) continue;
      await fetch(`${base}/api-keys/${encodeURIComponent(oldKey.name)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'X-Daytona-Organization-ID': orgId,
        },
        signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
      }).catch(() => {});
    }
  } catch {
    // Cleanup is strictly best-effort and must never block minting a fresh key.
  }
}

export async function mintPermanentDaytonaKey(
  jwt: string,
  orgId: string,
  flowId: string,
): Promise<string> {
  const base = daytonaApiBaseUrl();
  await cleanupStaleKortixApiKeys(jwt, orgId);

  const shortTs = Date.now().toString(36);
  const shortFlow = flowId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'key';
  for (let attempt = 0; attempt < 3; attempt++) {
    const suffix = attempt === 0 ? '' : `-${randomBytes(2).toString('hex')}`;
    const keyName = `kortix-app-${shortTs}-${shortFlow}${suffix}`;
    const res = await fetch(`${base}/api-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Daytona-Organization-ID': orgId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        name: keyName,
        permissions: [...REQUIRED_DAYTONA_KEY_PERMISSIONS],
        expiresAt: null,
      }),
      signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
    });
    const text = await res.text();
    const isCollision =
      res.status === 409 ||
      (res.status === 400 && text.toLowerCase().includes('already exists'));
    if (isCollision && attempt < 2) continue;
    if (!res.ok) {
      console.error(
        `[daytona-onboarding] POST /api-keys failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
      );
      const classified = classifyDaytonaError(res.status, text);
      throw new DaytonaStructuredError(classified.code, classified.message, 502);
    }
    const created = JSON.parse(text) as { value?: string };
    if (!created.value || !created.value.startsWith('dtn_')) {
      throw new DaytonaStructuredError(
        'DAYTONA_RECONNECT_REQUIRED',
        'Daytona did not return a valid workspace key. Please try connecting again.',
        502,
      );
    }
    return created.value;
  }
  throw new DaytonaStructuredError(
    'DAYTONA_RECONNECT_REQUIRED',
    'Could not create a Daytona workspace key after retrying. Please try again.',
    502,
  );
}

export function pollDaytonaConnect(flowId: string): Promise<PollDaytonaConnectResult> {
  const existing = pollFlowInFlight.get(flowId);
  if (existing) return existing;

  const task = (async (): Promise<PollDaytonaConnectResult> => {
    const cachedErr = flowTerminalErrorCache.get(flowId);
    if (cachedErr && cachedErr.expiresAt > Date.now()) {
      throw new DaytonaStructuredError(cachedErr.code, cachedErr.message, cachedErr.httpStatus);
    }
    if (cachedErr) {
      flowTerminalErrorCache.delete(flowId);
    }

    const rows = await db
      .select()
      .from(daytonaConnectFlows)
      .where(eq(daytonaConnectFlows.flowId, flowId))
      .limit(1);
    const flow = rows[0];
    if (!flow) {
      throw new Error('Daytona onboarding flow not found');
    }

    if (flow.status === 'approved' && flow.claimToken && flow.daytonaOrgId) {
      return {
        status: 'approved',
        claimToken: flow.claimToken,
        orgId: flow.daytonaOrgId,
        region: flow.daytonaRegion || 'eu',
      };
    }
    if (flow.status === 'claimed') {
      return {
        status: 'claimed',
        orgId: flow.daytonaOrgId ?? null,
        region: flow.daytonaRegion ?? null,
      };
    }
    if (flow.status === 'expired' || flow.expiresAt.getTime() <= Date.now()) {
      if (flow.status !== 'expired') {
        await db
          .update(daytonaConnectFlows)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(eq(daytonaConnectFlows.flowId, flowId));
      }
      return { status: 'expired' };
    }

    const oidc = await getDaytonaWorkosOidcConfig();
    const tokRes = await fetch(oidc.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: flow.deviceCode,
        client_id: oidc.clientId,
      }).toString(),
      signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
    });

    const tokText = await tokRes.text();
    if (!tokRes.ok) {
      let errCode = '';
      try {
        errCode = String((JSON.parse(tokText) as { error?: string }).error || '');
      } catch {
        errCode = '';
      }
      if (errCode === 'authorization_pending') {
        return { status: 'pending' };
      }
      if (errCode === 'slow_down') {
        return { status: 'pending', slowDown: true };
      }
      if (
        errCode === 'expired_token' ||
        errCode === 'access_denied' ||
        errCode === 'invalid_grant'
      ) {
        await db
          .update(daytonaConnectFlows)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(eq(daytonaConnectFlows.flowId, flowId));
        return { status: 'expired' };
      }
      throw new Error(`WorkOS token poll failed (HTTP ${tokRes.status}): ${tokText.slice(0, 200)}`);
    }

    const tok = JSON.parse(tokText) as { access_token?: string };
    const jwt = tok.access_token;
    if (!jwt) {
      throw new Error('WorkOS token exchange succeeded without access_token');
    }

    // WorkOS device_code is single-use: once we receive `jwt`, any subsequent call to
    // WorkOS with this device_code returns `invalid_grant`/`expired_token`. Cache any
    // post-JWT Daytona refusal (e.g. EMAIL_ACCESS_DENIED, Depleted credits) on `flowId`
    // so subsequent client polls surface the real error instead of falsely reporting "expired".
    let org: DaytonaOrgSummary;
    let region: string;
    let permanentApiKey: string;
    try {
      const orgs = await fetchOrganizationsWithPropagationRetry(jwt);
      const foundOrg = orgs.find((o) => o.personal) || orgs[0];
      if (!foundOrg?.id) {
        throw new DaytonaStructuredError(
          'DAYTONA_TIMEOUT',
          'Your new Daytona personal workspace is still initializing. Tap New code in a moment.',
          503,
        );
      }
      if (foundOrg.suspended) {
        const reason = String(foundOrg.suspensionReason || '');
        console.warn(
          `[daytona-onboarding] org ${foundOrg.id} is suspended (reason=${reason || 'none'})`,
        );
        if (/credit|depleted|billing|quota/i.test(reason)) {
          throw new DaytonaStructuredError(
            'DAYTONA_QUOTA_EXCEEDED',
            HUMAN_ERROR_COPY.DAYTONA_QUOTA_EXCEEDED,
            402,
          );
        }
        throw new DaytonaStructuredError(
          'DAYTONA_EMAIL_UNVERIFIED',
          HUMAN_ERROR_COPY.DAYTONA_EMAIL_UNVERIFIED,
          400,
        );
      }
      org = foundOrg;
      region = await ensureDefaultRegionOnOrg(jwt, org.id, org.defaultRegionId);
      permanentApiKey = await mintPermanentDaytonaKey(jwt, org.id, flowId);
    } catch (postJwtErr) {
      const structured =
        postJwtErr instanceof DaytonaStructuredError
          ? postJwtErr
          : (() => {
              const classified = classifyDaytonaError(postJwtErr);
              return new DaytonaStructuredError(classified.code, classified.message, 400);
            })();
      lruSet(
        flowTerminalErrorCache,
        flowId,
        {
          code: structured.code,
          message: structured.message,
          httpStatus: structured.httpStatus,
          expiresAt: Date.now() + 15 * 60_000,
        },
        500,
      );
      throw structured;
    }

    const encrypted = encryptDaytonaApiKey(flowId, permanentApiKey);
    const claimToken = randomBytes(32).toString('base64url');
    // Extend TTL so the user has up to 15 minutes to finish Step 2 (Kortix sign-in).
    const claimExpiresAt = new Date(Date.now() + 15 * 60_000);

    await db
      .update(daytonaConnectFlows)
      .set({
        status: 'approved',
        encryptedApiKey: encrypted.encryptedApiKey,
        encryptionIv: encrypted.encryptionIv,
        encryptionTag: encrypted.encryptionTag,
        daytonaOrgId: org.id,
        daytonaRegion: region,
        claimToken,
        expiresAt: claimExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(daytonaConnectFlows.flowId, flowId));

    // Fire-and-forget: kick off the 6 GB GHCR snapshot pull strictly asynchronously
    // AFTER returning approved, so /poll never blocks or fails on snapshot creation.
    setImmediate(() => {
      void ensureUserSnapshot({
        apiKey: permanentApiKey,
        daytonaOrgId: org.id,
        daytonaRegion: region,
      }).catch((err) => {
        console.warn(
          '[daytona-onboarding] background pre-claim snapshot pull failed:',
          err instanceof Error ? err.message : String(err),
        );
      });
    });

    return {
      status: 'approved',
      claimToken,
      orgId: org.id,
      region,
    };
  })().finally(() => {
    pollFlowInFlight.delete(flowId);
  });

  pollFlowInFlight.set(flowId, task);
  return task;
}

export interface DaytonaOnboardingStatusResult {
  connected: boolean;
  orgId: string | null;
  region: string | null;
  snapshotName: string | null;
  snapshotStatus: UserDaytonaSnapshotStatus | null;
  snapshotErrorCode: DaytonaOnboardingErrorCode | null;
  snapshotError: string | null;
  reconnectRequired?: boolean;
}

export async function claimDaytonaConnect(
  userId: string,
  claimToken: string,
): Promise<DaytonaOnboardingStatusResult> {
  const now = new Date();
  const rows = await db
    .select()
    .from(daytonaConnectFlows)
    .where(
      and(
        eq(daytonaConnectFlows.claimToken, claimToken),
        eq(daytonaConnectFlows.status, 'approved'),
        gt(daytonaConnectFlows.expiresAt, now),
      ),
    )
    .limit(1);
  const flow = rows[0];
  if (
    !flow ||
    !flow.encryptedApiKey ||
    !flow.encryptionIv ||
    !flow.encryptionTag ||
    !flow.daytonaOrgId
  ) {
    throw new Error('Invalid or expired Daytona claim token. Please reconnect Daytona.');
  }

  const plaintextApiKey = decryptDaytonaApiKey(flow.flowId, {
    encryptedApiKey: flow.encryptedApiKey,
    encryptionIv: flow.encryptionIv,
    encryptionTag: flow.encryptionTag,
  });

  const userEncrypted = encryptDaytonaApiKey(userId, plaintextApiKey);
  const region = flow.daytonaRegion || config.DAYTONA_TARGET || 'eu';
  const pinnedImg = getPinnedGhcrSandboxImage();
  const initialSnapshotName = pinnedImg ? deriveSnapshotNameForImage(pinnedImg) : null;

  // Atomically claim the flow (clearing its temporary key copy) and bind to user_daytona_credentials.
  await db.transaction(async (tx) => {
    const claimed = await tx
      .update(daytonaConnectFlows)
      .set({
        status: 'claimed',
        encryptedApiKey: null,
        encryptionIv: null,
        encryptionTag: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(daytonaConnectFlows.flowId, flow.flowId),
          eq(daytonaConnectFlows.status, 'approved'),
        ),
      )
      .returning({ flowId: daytonaConnectFlows.flowId });
    if (claimed.length === 0) {
      throw new Error('Daytona claim token was already used.');
    }

    await tx
      .insert(userDaytonaCredentials)
      .values({
        userId,
        encryptedApiKey: userEncrypted.encryptedApiKey,
        encryptionIv: userEncrypted.encryptionIv,
        encryptionTag: userEncrypted.encryptionTag,
        daytonaOrgId: flow.daytonaOrgId!,
        daytonaRegion: region,
        snapshotName: initialSnapshotName,
        snapshotStatus: 'pulling',
        snapshotError: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userDaytonaCredentials.userId,
        set: {
          encryptedApiKey: userEncrypted.encryptedApiKey,
          encryptionIv: userEncrypted.encryptionIv,
          encryptionTag: userEncrypted.encryptionTag,
          daytonaOrgId: flow.daytonaOrgId!,
          daytonaRegion: region,
          snapshotName: initialSnapshotName,
          snapshotStatus: 'pulling',
          snapshotError: null,
          updatedAt: new Date(),
        },
      });
  });

  invalidateUserDaytonaCache(userId);

  // Trigger snapshot pull strictly asynchronously so /claim returns immediately
  // and the client transitions smoothly into the live 3-stage setup progress screen.
  const verifiedCacheKey = initialSnapshotName ? `${flow.daytonaOrgId}:${initialSnapshotName}` : null;
  const alreadyActive =
    verifiedCacheKey !== null &&
    verifiedActiveSnapshotCache.get(verifiedCacheKey) !== undefined &&
    Date.now() - (verifiedActiveSnapshotCache.get(verifiedCacheKey) ?? 0) < SNAPSHOT_ACTIVE_VERIFY_TTL_MS;

  if (alreadyActive && initialSnapshotName) {
    await updateUserSnapshotDbState(userId, {
      snapshotName: initialSnapshotName,
      snapshotStatus: 'active',
      snapshotError: null,
    });
    return {
      connected: true,
      orgId: flow.daytonaOrgId,
      region,
      snapshotName: initialSnapshotName,
      snapshotStatus: 'active',
      snapshotErrorCode: null,
      snapshotError: null,
      reconnectRequired: false,
    };
  }

  setImmediate(() => {
    void ensureUserSnapshot({
      userId,
      apiKey: plaintextApiKey,
      daytonaOrgId: flow.daytonaOrgId!,
      daytonaRegion: region,
    }).catch((err) => {
      console.warn(
        '[daytona-onboarding] post-claim background snapshot pull failed:',
        err instanceof Error ? err.message : String(err),
      );
    });
  });

  return {
    connected: true,
    orgId: flow.daytonaOrgId,
    region,
    snapshotName: initialSnapshotName,
    snapshotStatus: 'pulling',
    snapshotErrorCode: null,
    snapshotError: null,
    reconnectRequired: false,
  };
}

export async function getDaytonaOnboardingStatus(
  userId: string,
): Promise<DaytonaOnboardingStatusResult> {
  if (!hasDatabase) {
    return {
      connected: false,
      orgId: null,
      region: null,
      snapshotName: null,
      snapshotStatus: null,
      snapshotErrorCode: null,
      snapshotError: null,
      reconnectRequired: false,
    };
  }
  const rows = await db
    .select()
    .from(userDaytonaCredentials)
    .where(eq(userDaytonaCredentials.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      connected: false,
      orgId: null,
      region: null,
      snapshotName: null,
      snapshotStatus: null,
      snapshotErrorCode: null,
      snapshotError: null,
      reconnectRequired: false,
    };
  }

  const pinnedImg = getPinnedGhcrSandboxImage();
  const expectedSnapshotName = pinnedImg ? deriveSnapshotNameForImage(pinnedImg) : null;
  const needsLiveRefresh =
    row.snapshotStatus === 'pending' ||
    row.snapshotStatus === 'pulling' ||
    row.snapshotStatus === 'inactive' ||
    row.snapshotStatus === 'failed' ||
    (expectedSnapshotName !== null && row.snapshotName !== expectedSnapshotName);

  if (needsLiveRefresh) {
    try {
      const ctx = await getUserDaytonaContext(userId);
      if (ctx) {
        const snap = await ensureUserSnapshot({
          userId,
          apiKey: ctx.apiKey,
          daytonaOrgId: ctx.daytonaOrgId,
          daytonaRegion: ctx.daytonaRegion,
        });
        // Keep returning 'pulling' during a cold 6 GB pull if a single status check hits a transient timeout.
        const pullAgeMs = row.createdAt ? Date.now() - row.createdAt.getTime() : 0;
        if (
          snap.snapshotStatus === 'failed' &&
          snap.snapshotErrorCode === 'DAYTONA_TIMEOUT' &&
          (row.snapshotStatus === 'pulling' || row.snapshotStatus === 'pending') &&
          pullAgeMs < DAYTONA_SNAPSHOT_PULL_GRACE_MS
        ) {
          return {
            connected: true,
            orgId: ctx.daytonaOrgId,
            region: ctx.daytonaRegion,
            snapshotName: snap.snapshotName || row.snapshotName,
            snapshotStatus: 'pulling',
            snapshotErrorCode: null,
            snapshotError: null,
            reconnectRequired: false,
          };
        }
        return {
          connected: true,
          orgId: ctx.daytonaOrgId,
          region: ctx.daytonaRegion,
          snapshotName: snap.snapshotName || row.snapshotName,
          snapshotStatus: snap.snapshotStatus,
          snapshotErrorCode: snap.snapshotErrorCode,
          snapshotError: snap.snapshotError,
          reconnectRequired: Boolean(snap.reconnectRequired),
        };
      }
    } catch (err) {
      if (isDaytonaReconnectRequiredError(err)) {
        return {
          connected: true,
          orgId: row.daytonaOrgId,
          region: row.daytonaRegion,
          snapshotName: row.snapshotName,
          snapshotStatus: 'failed',
          snapshotErrorCode: 'DAYTONA_RECONNECT_REQUIRED',
          snapshotError: HUMAN_ERROR_COPY.DAYTONA_RECONNECT_REQUIRED,
          reconnectRequired: true,
        };
      }
    }
  }

  const sanitized = sanitizeStoredDaytonaError(row.snapshotError);
  return {
    connected: true,
    orgId: row.daytonaOrgId,
    region: row.daytonaRegion,
    snapshotName: row.snapshotName,
    snapshotStatus: row.snapshotStatus,
    snapshotErrorCode: sanitized?.code ?? null,
    snapshotError: sanitized?.message ?? null,
    reconnectRequired: Boolean(sanitized?.reconnectRequired),
  };
}

export async function saveManualDaytonaKey(
  userId: string,
  rawApiKey: string,
  preferredRegion?: string,
): Promise<DaytonaOnboardingStatusResult> {
  const apiKey = rawApiKey.trim();
  if (!apiKey || apiKey.length < 16) {
    throw new Error('Please paste a valid Daytona API key (starts with dtn_).');
  }
  const base = daytonaApiBaseUrl();
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  const [curRes, snapRes] = await Promise.all([
    fetch(`${base}/api-keys/current`, {
      headers,
      signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
    }),
    fetch(`${base}/snapshots?limit=1`, {
      headers,
      signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
    }),
  ]);

  if (!curRes.ok || !snapRes.ok) {
    throw new Error('Daytona rejected this API key. Check that the key is active and has sandbox + snapshot permissions.');
  }

  const curBody = (await curRes.json().catch(() => ({}))) as {
    organizationId?: string;
    permissions?: string[];
  };
  const snapBody = (await snapRes.json().catch(() => ({}))) as {
    items?: Array<{ organizationId?: string; regionIds?: string[] }>;
  };

  if (Array.isArray(curBody.permissions) && curBody.permissions.length > 0) {
    const missing = ['write:sandboxes', 'write:snapshots'].filter(
      (p) => !curBody.permissions!.includes(p),
    );
    if (missing.length > 0) {
      throw new Error(`This Daytona API key is missing required permissions: ${missing.join(', ')}`);
    }
  }

  const detectedOrgId =
    curBody.organizationId ||
    snapBody.items?.find((it) => it.organizationId)?.organizationId ||
    `manual-${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;

  const detectedRegion =
    preferredRegion?.trim() ||
    snapBody.items?.find((it) => Array.isArray(it.regionIds) && it.regionIds.length > 0)?.regionIds?.[0] ||
    config.DAYTONA_TARGET ||
    'eu';

  const encrypted = encryptDaytonaApiKey(userId, apiKey);
  const pinnedImg = getPinnedGhcrSandboxImage();
  const initialSnapshotName = pinnedImg ? deriveSnapshotNameForImage(pinnedImg) : null;

  await db
    .insert(userDaytonaCredentials)
    .values({
      userId,
      encryptedApiKey: encrypted.encryptedApiKey,
      encryptionIv: encrypted.encryptionIv,
      encryptionTag: encrypted.encryptionTag,
      daytonaOrgId: detectedOrgId,
      daytonaRegion: detectedRegion,
      snapshotName: initialSnapshotName,
      snapshotStatus: 'pulling',
      snapshotError: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userDaytonaCredentials.userId,
      set: {
        encryptedApiKey: encrypted.encryptedApiKey,
        encryptionIv: encrypted.encryptionIv,
        encryptionTag: encrypted.encryptionTag,
        daytonaOrgId: detectedOrgId,
        daytonaRegion: detectedRegion,
        snapshotName: initialSnapshotName,
        snapshotStatus: 'pulling',
        snapshotError: null,
        updatedAt: new Date(),
      },
    });

  invalidateUserDaytonaCache(userId);

  const verifiedCacheKey = initialSnapshotName ? `${detectedOrgId}:${initialSnapshotName}` : null;
  const alreadyActive =
    verifiedCacheKey !== null &&
    verifiedActiveSnapshotCache.get(verifiedCacheKey) !== undefined &&
    Date.now() - (verifiedActiveSnapshotCache.get(verifiedCacheKey) ?? 0) < SNAPSHOT_ACTIVE_VERIFY_TTL_MS;

  if (alreadyActive && initialSnapshotName) {
    await updateUserSnapshotDbState(userId, {
      snapshotName: initialSnapshotName,
      snapshotStatus: 'active',
      snapshotError: null,
    });
    return {
      connected: true,
      orgId: detectedOrgId,
      region: detectedRegion,
      snapshotName: initialSnapshotName,
      snapshotStatus: 'active',
      snapshotErrorCode: null,
      snapshotError: null,
      reconnectRequired: false,
    };
  }

  // Trigger snapshot pull strictly asynchronously so manual key entry also enters
  // the workspace immediately while the image prepares in the background.
  setImmediate(() => {
    void ensureUserSnapshot({
      userId,
      apiKey,
      daytonaOrgId: detectedOrgId,
      daytonaRegion: detectedRegion,
    }).catch((err) => {
      console.warn(
        '[daytona-onboarding] background manual-key snapshot pull failed:',
        err instanceof Error ? err.message : String(err),
      );
    });
  });

  return {
    connected: true,
    orgId: detectedOrgId,
    region: detectedRegion,
    snapshotName: initialSnapshotName,
    snapshotStatus: 'pulling',
    snapshotErrorCode: null,
    snapshotError: null,
    reconnectRequired: false,
  };
}

export async function disconnectUserDaytona(userId: string): Promise<void> {
  if (!hasDatabase) return;
  await db
    .delete(userDaytonaCredentials)
    .where(eq(userDaytonaCredentials.userId, userId));
  invalidateUserDaytonaCache(userId);
}
