import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Daytona } from '@daytonaio/sdk';
import { and, eq, gt, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
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
import { stopDaytonaSandboxById } from '../shared/daytona';
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
  maxRunningSandboxes?: number | null;
  maxNonArchivedSandboxes?: number | null;
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

// replica-local: short-lived decrypted per-user Daytona client cache; invalidated on disconnect/reclaim/401.
const userContextCache = new Map<string, { value: UserDaytonaContext; expiresAt: number }>();
// replica-local: short-lived externalId -> ownerUserId lookup cache; backed by session_sandboxes in DB.
const externalOwnerCache = new Map<string, { userId: string; orgId?: string; expiresAt: number }>();
// replica-local: short-lived accountId -> ownerUserId lookup cache; backed by account_members in DB.
const accountOwnerCache = new Map<string, { userId: string | null; expiresAt: number }>();
// replica-local: short-lived active snapshot cache per org; verified against Daytona on miss.
const verifiedActiveSnapshotCache = new Map<string, number>(); // `${orgId}:${snapshotName}` -> verifiedAtMs
// replica-local: in-process single-flight dedup for concurrent snapshot ensures; DB holds authoritative state.
const ensureSnapshotInFlight = new Map<string, Promise<EnsureUserSnapshotResult>>();
// replica-local: in-process single-flight dedup for concurrent polls; DB CAS ('pending' -> 'exchanging') coordinates across replicas.
const pollFlowInFlight = new Map<string, Promise<PollDaytonaConnectResult>>();
// replica-local: short-lived fallback cache for terminal errors; DB columns terminal_error_* are the cross-replica source of truth.
const flowTerminalErrorCache = new Map<
  string,
  { code: DaytonaOnboardingErrorCode; message: string; httpStatus: number; expiresAt: number }
>();
// replica-local: short-lived AES-256-GCM encrypted WorkOS JWT cache for flows awaiting Daytona email verification,
// allowing the same single-use device_code approval to resume cleanly once the user confirms their email.
const pendingEmailVerifyJwtCache = new Map<
  string,
  { encryptedApiKey: string; encryptionIv: string; encryptionTag: string; expiresAt: number }
>();

export function getDaytonaClaimTtlMs(): number {
  const mins = Number((config as { KORTIX_DAYTONA_CLAIM_TTL_MINUTES?: number }).KORTIX_DAYTONA_CLAIM_TTL_MINUTES ?? 60);
  return Math.max(5, Number.isFinite(mins) && mins > 0 ? mins : 60) * 60_000;
}

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
  for (const [extId, entry] of externalOwnerCache.entries()) {
    if (entry.userId === userId) {
      externalOwnerCache.delete(extId);
    }
  }
  userContextCache.delete(userId);
}

/**
 * Best-effort persistence of learned per-org sandbox caps into
 * `user_daytona_credentials` (populated after Daytona quota rejections so
 * future passes size capacity accurately across replicas).
 */
export async function persistLearnedDaytonaOrgCap(
  daytonaOrgId: string,
  patch: { maxRunningSandboxes?: number; maxNonArchivedSandboxes?: number },
): Promise<void> {
  if (!hasDatabase || !daytonaOrgId) return;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof patch.maxRunningSandboxes === 'number' && patch.maxRunningSandboxes >= 1) {
    set.maxRunningSandboxes = Math.floor(patch.maxRunningSandboxes);
  }
  if (typeof patch.maxNonArchivedSandboxes === 'number' && patch.maxNonArchivedSandboxes >= 1) {
    set.maxNonArchivedSandboxes = Math.floor(patch.maxNonArchivedSandboxes);
  }
  if (Object.keys(set).length <= 1) return;
  try {
    await db
      .update(userDaytonaCredentials)
      .set(set)
      .where(eq(userDaytonaCredentials.daytonaOrgId, daytonaOrgId));
    for (const entry of userContextCache.values()) {
      if (entry.value.daytonaOrgId === daytonaOrgId) {
        if (typeof set.maxRunningSandboxes === 'number') {
          entry.value.maxRunningSandboxes = set.maxRunningSandboxes;
        }
        if (typeof set.maxNonArchivedSandboxes === 'number') {
          entry.value.maxNonArchivedSandboxes = set.maxNonArchivedSandboxes;
        }
      }
    }
  } catch (err) {
    logger.debug('[daytona-onboarding] persistLearnedDaytonaOrgCap skipped', {
      daytonaOrgId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

export const MAX_SNAPSHOT_ATTEMPTS = 5;
const SNAPSHOT_BACKOFF_BASE_MS = 15_000;
const SNAPSHOT_BACKOFF_MAX_MS = 10 * 60_000;

export function computeSnapshotRetryDelayMs(attempt: number): number {
  const exp = Math.max(0, Math.min(attempt - 1, 10));
  return Math.min(SNAPSHOT_BACKOFF_MAX_MS, SNAPSHOT_BACKOFF_BASE_MS * 2 ** exp);
}

export function getPinnedGhcrSandboxImage(): string | null {
  const raw = config.KORTIX_SANDBOX_GHCR_IMAGE?.trim();
  if (!raw) return null;
  if (raw.endsWith(':latest')) {
    throw new DaytonaStructuredError(
      'DAYTONA_SNAPSHOT_CONFIG_INVALID',
      'KORTIX_SANDBOX_GHCR_IMAGE must use an immutable pinned tag or digest, never :latest.',
      500,
      false,
    );
  }
  if (!raw.includes(':') && !raw.includes('@sha256:')) {
    throw new DaytonaStructuredError(
      'DAYTONA_SNAPSHOT_CONFIG_INVALID',
      'KORTIX_SANDBOX_GHCR_IMAGE must include an explicit tag or @sha256 digest.',
      500,
      false,
    );
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

async function updateOrgSnapshotDbState(
  daytonaOrgId: string | undefined,
  userId: string | undefined,
  patch: {
    snapshotName?: string;
    snapshotStatus: UserDaytonaSnapshotStatus;
    snapshotError?: string | null;
    snapshotAttempts?: number;
    snapshotNextRetryAt?: Date | null;
  },
): Promise<void> {
  if (!hasDatabase) return;
  const whereClause = daytonaOrgId
    ? eq(userDaytonaCredentials.daytonaOrgId, daytonaOrgId)
    : userId
      ? eq(userDaytonaCredentials.userId, userId)
      : null;
  if (!whereClause) return;
  try {
    await db
      .update(userDaytonaCredentials)
      .set({
        ...(patch.snapshotName !== undefined ? { snapshotName: patch.snapshotName } : {}),
        snapshotStatus: patch.snapshotStatus,
        snapshotError: patch.snapshotError ?? null,
        ...(patch.snapshotAttempts !== undefined ? { snapshotAttempts: patch.snapshotAttempts } : {}),
        ...(patch.snapshotNextRetryAt !== undefined
          ? { snapshotNextRetryAt: patch.snapshotNextRetryAt }
          : {}),
        updatedAt: new Date(),
      })
      .where(whereClause);
    for (const [uid, cached] of userContextCache.entries()) {
      if ((daytonaOrgId && cached.value.daytonaOrgId === daytonaOrgId) || (userId && uid === userId)) {
        if (patch.snapshotName !== undefined) cached.value.snapshotName = patch.snapshotName;
        cached.value.snapshotStatus = patch.snapshotStatus;
      }
    }
  } catch (err) {
    logger.warn('[daytona-onboarding] failed to update snapshot state in DB', {
      daytonaOrgId: daytonaOrgId ?? null,
      userId: userId ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function updateUserSnapshotDbState(
  userId: string | undefined,
  patch: {
    snapshotName?: string;
    snapshotStatus: UserDaytonaSnapshotStatus;
    snapshotError?: string | null;
    snapshotAttempts?: number;
    snapshotNextRetryAt?: Date | null;
  },
): Promise<void> {
  await updateOrgSnapshotDbState(undefined, userId, patch);
}

/**
 * Read-only observation of the pinned GHCR snapshot in a user's Daytona org.
 * NEVER sends POST, DELETE, or PATCH to Daytona. Safe for `GET /status`.
 */
export async function inspectUserSnapshotReadOnly(opts: {
  userId?: string;
  apiKey: string;
  daytonaOrgId: string;
}): Promise<EnsureUserSnapshotResult> {
  const imageRef = getPinnedGhcrSandboxImage();
  if (!imageRef) {
    return {
      snapshotName: '',
      snapshotStatus: 'failed',
      snapshotErrorCode: 'DAYTONA_SNAPSHOT_CONFIG_INVALID',
      snapshotError: HUMAN_ERROR_COPY.DAYTONA_SNAPSHOT_CONFIG_INVALID,
      reconnectRequired: false,
    };
  }
  const snapshotName = deriveSnapshotNameForImage(imageRef);
  const flightKey = `${opts.daytonaOrgId}:${snapshotName}`;
  const base = daytonaApiBaseUrl();

  const getRes = await fetch(`${base}/snapshots/${encodeURIComponent(snapshotName)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
  });

  if (getRes.status === 401) {
    if (opts.userId) invalidateUserDaytonaCache(opts.userId);
    await updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
      snapshotName,
      snapshotStatus: 'failed',
      snapshotError: 'DAYTONA_RECONNECT_REQUIRED',
    });
    throw new DaytonaReconnectRequiredError();
  }

  if (getRes.status === 404) {
    // Snapshot not yet created in Daytona; do NOT mutate from GET /status.
    return {
      snapshotName,
      snapshotStatus: 'pending',
      snapshotErrorCode: null,
      snapshotError: null,
      reconnectRequired: false,
    };
  }

  if (!getRes.ok) {
    const body = await getRes.text().catch(() => '');
    const classified = classifyDaytonaError(getRes.status, body);
    await updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
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

  const snap = (await getRes.json()) as {
    id: string;
    name: string;
    state?: string;
    errorReason?: string;
  };
  const mapped = mapDaytonaSnapshotState(snap.state);

  if (mapped === 'active') {
    verifiedActiveSnapshotCache.set(flightKey, Date.now());
    await updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
      snapshotName,
      snapshotStatus: 'active',
      snapshotError: null,
      snapshotAttempts: 0,
      snapshotNextRetryAt: null,
    });
    return {
      snapshotName,
      snapshotStatus: 'active',
      snapshotErrorCode: null,
      snapshotError: null,
      reconnectRequired: false,
    };
  }

  if (mapped === 'failed') {
    const classified = classifyDaytonaError(0, snap.errorReason || 'DAYTONA_SNAPSHOT_FAILED');
    await updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
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

  await updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
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

/**
 * Ensure the pinned GHCR Kortix sandbox snapshot exists and is active/pulling
 * inside a user's own Daytona organization.
 *
 * Single-flight per `daytonaOrgId:snapshotName`; persists DB state to ALL users
 * in `daytonaOrgId` regardless of who started the flight. Bounded by
 * `MAX_SNAPSHOT_ATTEMPTS` with exponential backoff — never loops delete+recreate.
 */
export function ensureUserSnapshot(opts: {
  userId?: string;
  apiKey: string;
  daytonaOrgId: string;
  daytonaRegion: string;
  allowDeleteErrored?: boolean;
  resetAttempts?: boolean;
}): Promise<EnsureUserSnapshotResult> {
  const imageRef = getPinnedGhcrSandboxImage();
  if (!imageRef) {
    void updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
      snapshotStatus: 'failed',
      snapshotError: 'DAYTONA_SNAPSHOT_CONFIG_INVALID',
    });
    return Promise.resolve({
      snapshotName: '',
      snapshotStatus: 'failed',
      snapshotErrorCode: 'DAYTONA_SNAPSHOT_CONFIG_INVALID',
      snapshotError: HUMAN_ERROR_COPY.DAYTONA_SNAPSHOT_CONFIG_INVALID,
      reconnectRequired: false,
    });
  }
  const snapshotName = deriveSnapshotNameForImage(imageRef);
  const flightKey = `${opts.daytonaOrgId}:${snapshotName}`;
  const existingFlight = ensureSnapshotInFlight.get(flightKey);
  if (existingFlight) {
    // Ensure a late joiner's user row stays consistent once the shared flight settles.
    return existingFlight.then(async (res) => {
      if (opts.userId) {
        await updateUserSnapshotDbState(opts.userId, {
          snapshotName: res.snapshotName || snapshotName,
          snapshotStatus: res.snapshotStatus,
          snapshotError: res.snapshotErrorCode,
        });
      }
      return res;
    });
  }

  const task = (async (): Promise<EnsureUserSnapshotResult> => {
    const base = daytonaApiBaseUrl();
    const authHeaders = {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: 'application/json',
    };

    // Load current retry budget from DB (if available) to enforce bounded retries + backoff.
    let currentAttempts = 0;
    let nextRetryAt: Date | null = null;
    if (hasDatabase && !opts.resetAttempts) {
      try {
        const credRows = await db
          .select({
            snapshotAttempts: userDaytonaCredentials.snapshotAttempts,
            snapshotNextRetryAt: userDaytonaCredentials.snapshotNextRetryAt,
          })
          .from(userDaytonaCredentials)
          .where(eq(userDaytonaCredentials.daytonaOrgId, opts.daytonaOrgId))
          .limit(1);
        if (credRows[0]) {
          currentAttempts = credRows[0].snapshotAttempts ?? 0;
          nextRetryAt = credRows[0].snapshotNextRetryAt ?? null;
        }
      } catch {
        // Non-fatal: proceed with attempt 0.
      }
    }

    const recordFailure = async (
      classified: ClassifiedDaytonaError,
    ): Promise<EnsureUserSnapshotResult> => {
      const nextAttempt = currentAttempts + 1;
      const retryAt =
        classified.retriable && nextAttempt < MAX_SNAPSHOT_ATTEMPTS
          ? new Date(Date.now() + computeSnapshotRetryDelayMs(nextAttempt))
          : null;
      await updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
        snapshotName,
        snapshotStatus: 'failed',
        snapshotError: classified.code,
        snapshotAttempts: nextAttempt,
        snapshotNextRetryAt: retryAt,
      });
      return {
        snapshotName,
        snapshotStatus: 'failed',
        snapshotErrorCode: classified.code,
        snapshotError: classified.message,
        reconnectRequired: classified.reconnectRequired,
      };
    };

    try {
      const getRes = await fetch(`${base}/snapshots/${encodeURIComponent(snapshotName)}`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
      });

      if (getRes.status === 401) {
        if (opts.userId) invalidateUserDaytonaCache(opts.userId);
        await updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
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
          await updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
            snapshotName,
            snapshotStatus: 'active',
            snapshotError: null,
            snapshotAttempts: 0,
            snapshotNextRetryAt: null,
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
          logger.info('[daytona-onboarding] activating inactive snapshot', {
            snapshotName,
            snapshotId: snap.id,
            orgId: opts.daytonaOrgId,
          });
          const actRes = await fetch(`${base}/snapshots/${encodeURIComponent(snap.id)}/activate`, {
            method: 'POST',
            headers: authHeaders,
            signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
          });
          if (actRes.status === 401) {
            if (opts.userId) invalidateUserDaytonaCache(opts.userId);
            throw new DaytonaReconnectRequiredError();
          }
          if (actRes.ok) {
            await updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
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
          logger.warn('[daytona-onboarding] activate snapshot failed', {
            orgId: opts.daytonaOrgId,
            status: actRes.status,
            body: actErr.slice(0, 300),
          });
          return recordFailure(classifyDaytonaError(actRes.status, actErr));
        }

        if (mapped === 'pending' || mapped === 'pulling') {
          await updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
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

        // Previous snapshot errored: NEVER delete+recreate in a loop!
        // Only delete and recreate when explicitly permitted AND within retry budget/backoff.
        const classifiedErr = classifyDaytonaError(0, snap.errorReason || 'DAYTONA_SNAPSHOT_FAILED');
        const withinBudget = opts.resetAttempts || currentAttempts < MAX_SNAPSHOT_ATTEMPTS;
        const pastBackoff = opts.resetAttempts || !nextRetryAt || nextRetryAt.getTime() <= Date.now();
        if (!opts.allowDeleteErrored || !withinBudget || !pastBackoff) {
          return recordFailure(classifiedErr);
        }

        logger.warn('[daytona-onboarding] deleting errored snapshot for bounded retry', {
          snapshotName,
          snapshotId: snap.id,
          orgId: opts.daytonaOrgId,
          attempt: currentAttempts + 1,
          maxAttempts: MAX_SNAPSHOT_ATTEMPTS,
          reason: snap.errorReason ?? 'unknown',
        });
        await fetch(`${base}/snapshots/${encodeURIComponent(snap.id)}`, {
          method: 'DELETE',
          headers: authHeaders,
          signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
        }).catch(() => {});
      } else if (getRes.status !== 404) {
        const body = await getRes.text().catch(() => '');
        logger.warn('[daytona-onboarding] snapshot lookup failed', {
          orgId: opts.daytonaOrgId,
          status: getRes.status,
          body: body.slice(0, 300),
        });
        return recordFailure(classifyDaytonaError(getRes.status, body));
      } else {
        // Snapshot 404 (not yet created): respect attempt budget/backoff on repeated failures.
        const withinBudget = opts.resetAttempts || currentAttempts < MAX_SNAPSHOT_ATTEMPTS;
        const pastBackoff = opts.resetAttempts || !nextRetryAt || nextRetryAt.getTime() <= Date.now();
        if (!withinBudget || !pastBackoff) {
          return {
            snapshotName,
            snapshotStatus: 'failed',
            snapshotErrorCode: 'DAYTONA_SNAPSHOT_FAILED',
            snapshotError: HUMAN_ERROR_COPY.DAYTONA_SNAPSHOT_FAILED,
            reconnectRequired: false,
          };
        }
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

      logger.info('[daytona-onboarding] creating snapshot from pinned GHCR image', {
        snapshotName,
        imageRef,
        orgId: opts.daytonaOrgId,
        region: targetRegion,
        attempt: currentAttempts + 1,
      });
      let createRes: Response;
      try {
        createRes = await postCreateSnapshot();
      } catch (createErr) {
        const createClassified = classifyDaytonaError(
          createErr,
          createErr instanceof Error ? createErr.message : String(createErr),
        );
        if (createClassified.code === 'DAYTONA_TIMEOUT') {
          logger.warn('[daytona-onboarding] POST /snapshots timed out; treating as pulling', {
            snapshotName,
            orgId: opts.daytonaOrgId,
          });
          await updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
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

      if (createRes.status === 401) {
        if (opts.userId) invalidateUserDaytonaCache(opts.userId);
        throw new DaytonaReconnectRequiredError();
      }

      if (createRes.ok || createRes.status === 409) {
        await updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
          snapshotName,
          snapshotStatus: 'pulling',
          snapshotError: null,
          snapshotAttempts: opts.resetAttempts ? 0 : currentAttempts + 1,
          snapshotNextRetryAt: null,
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
      logger.warn('[daytona-onboarding] POST /snapshots failed', {
        orgId: opts.daytonaOrgId,
        status: createRes.status,
        body: errText.slice(0, 300),
      });
      let classified = classifyDaytonaError(createRes.status, errText);

      // Self-heal for orgs connected before PATCH /default-region shipped:
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
            createRes = await postCreateSnapshot();
            if (createRes.ok || createRes.status === 409) {
              await updateOrgSnapshotDbState(opts.daytonaOrgId, opts.userId, {
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
          }
        } catch (patchErr) {
          logger.warn('[daytona-onboarding] self-heal PATCH default-region threw', {
            orgId: opts.daytonaOrgId,
            error: patchErr instanceof Error ? patchErr.message : String(patchErr),
          });
        }
      }

      return recordFailure(classified);
    } catch (err) {
      if (isDaytonaReconnectRequiredError(err)) throw err;
      const rawMsg = err instanceof Error ? err.message : String(err);
      logger.warn('[daytona-onboarding] ensureUserSnapshot exception', {
        orgId: opts.daytonaOrgId,
        error: rawMsg,
      });
      return recordFailure(classifyDaytonaError(err, rawMsg));
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
    throw new DaytonaStructuredError(
      'DAYTONA_SNAPSHOT_CONFIG_INVALID',
      'KORTIX_SANDBOX_GHCR_IMAGE is not configured.',
      500,
      false,
    );
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
    last = await inspectUserSnapshotReadOnly({
      userId: ctx.userId,
      apiKey: ctx.apiKey,
      daytonaOrgId: ctx.daytonaOrgId,
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
    maxRunningSandboxes: row.maxRunningSandboxes ?? null,
    maxNonArchivedSandboxes: row.maxNonArchivedSandboxes ?? null,
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

export async function startDaytonaConnect(opts?: {
  clientIpHash?: string | null;
}): Promise<StartDaytonaConnectResult> {
  const clientIpHash = opts?.clientIpHash?.trim() || null;

  if (clientIpHash && hasDatabase) {
    const maxActivePerIp = config.KORTIX_DAYTONA_MAX_ACTIVE_FLOWS_PER_IP || 5;
    const activeRows = await db
      .select({ flowId: daytonaConnectFlows.flowId })
      .from(daytonaConnectFlows)
      .where(
        and(
          eq(daytonaConnectFlows.clientIpHash, clientIpHash),
          inArray(daytonaConnectFlows.status, ['pending', 'exchanging', 'approved']),
          gt(daytonaConnectFlows.expiresAt, new Date()),
        ),
      )
      .limit(maxActivePerIp + 1);
    if (activeRows.length >= maxActivePerIp) {
      throw new DaytonaStructuredError(
        'DAYTONA_TOO_MANY_FLOWS',
        HUMAN_ERROR_COPY.DAYTONA_TOO_MANY_FLOWS,
        429,
        true,
      );
    }
  }

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
  const expiresIn = Math.max(60, Math.min(3_600, Number(dc.expires_in ?? 600)));
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
    clientIpHash,
    expiresAt,
  });

  // Best-effort cleanup of already-settled flows (> 1h past expiry, key scrubbed).
  const pruneBefore = new Date(Date.now() - 60 * 60_000);
  void db
    .delete(daytonaConnectFlows)
    .where(
      and(
        lt(daytonaConnectFlows.expiresAt, pruneBefore),
        inArray(daytonaConnectFlows.status, ['claimed', 'expired']),
        sql`${daytonaConnectFlows.encryptedApiKey} IS NULL`,
      ),
    )
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
    logger.warn('[daytona-onboarding] GET /shared-regions failed, falling back to default', {
      error: err instanceof Error ? err.message : String(err),
    });
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
    logger.error('[daytona-onboarding] PATCH /organizations/:orgId/default-region failed', {
      orgId,
      region: chosen,
      status: patchRes.status,
      detail: errBody.slice(0, 300),
    });
    throw new DaytonaStructuredError(
      'DAYTONA_REGION_REQUIRED',
      HUMAN_ERROR_COPY.DAYTONA_REGION_REQUIRED,
      428,
    );
  }
  logger.info('[daytona-onboarding] set defaultRegionId on org', { orgId, region: chosen });
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
      logger.warn('[daytona-onboarding] GET /organizations failed', {
        status: orgsRes.status,
        attempt,
        maxAttempts,
        detail: errBody.slice(0, 200),
      });
      if (attempt < maxAttempts && (orgsRes.status >= 500 || orgsRes.status === 429)) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      const classified = classifyDaytonaError(orgsRes.status, errBody);
      throw new DaytonaStructuredError(classified.code, classified.message, classified.httpStatus);
    }
    const orgs = (await orgsRes.json()) as DaytonaOrgSummary[];
    if (Array.isArray(orgs) && orgs.length > 0) {
      return orgs;
    }
    if (attempt < maxAttempts) {
      logger.info('[daytona-onboarding] waiting for new personal org provisioning', {
        attempt,
        maxAttempts,
        delayMs,
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return [];
}

const STALE_UNREFERENCED_KEY_MIN_AGE_MS = 30 * 60_000;
const EXCHANGING_STALE_MS = 90_000;

/**
 * Prune ONLY provably unreferenced, old `kortix-app-*` API keys in `orgId`.
 *
 * Safety invariants (fixes shared-org key eviction bug):
 * 1. NEVER delete any key name referenced by `kortix.user_daytona_credentials`
 *    or an active `kortix.daytona_connect_flows` row in `orgId`.
 * 2. If any credential row in `orgId` has `daytona_key_name IS NULL` (legacy
 *    pre-migration row), keep at least `legacyNullCount + 2` newest unreferenced
 *    keys so pre-migration users sharing an org cannot be evicted.
 * 3. NEVER delete keys younger than 30 minutes (protects in-flight flows).
 * 4. Fail closed: if querying referenced keys fails, skip cleanup completely.
 */
async function cleanupStaleKortixApiKeys(jwt: string, orgId: string): Promise<void> {
  if (!hasDatabase) return;

  const referencedKeyNames = new Set<string>();
  let legacyNullCredCount = 0;
  try {
    const [credRows, flowRows] = await Promise.all([
      db
        .select({ daytonaKeyName: userDaytonaCredentials.daytonaKeyName })
        .from(userDaytonaCredentials)
        .where(eq(userDaytonaCredentials.daytonaOrgId, orgId)),
      db
        .select({ daytonaKeyName: daytonaConnectFlows.daytonaKeyName })
        .from(daytonaConnectFlows)
        .where(
          and(
            eq(daytonaConnectFlows.daytonaOrgId, orgId),
            inArray(daytonaConnectFlows.status, ['exchanging', 'approved']),
            gt(daytonaConnectFlows.expiresAt, new Date()),
          ),
        ),
    ]);
    for (const r of credRows) {
      if (r.daytonaKeyName) {
        referencedKeyNames.add(r.daytonaKeyName);
      } else {
        legacyNullCredCount += 1;
      }
    }
    for (const r of flowRows) {
      if (r.daytonaKeyName) referencedKeyNames.add(r.daytonaKeyName);
    }
  } catch (err) {
    logger.warn('[daytona-onboarding] skipping stale key cleanup because DB reference query failed', {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

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
    const now = Date.now();
    const unreferencedKortixKeys = keys
      .filter(
        (k) =>
          typeof k.name === 'string' &&
          k.name.startsWith('kortix-app-') &&
          !referencedKeyNames.has(k.name),
      )
      .sort((a, b) => Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0'));

    // Preserve newest unreferenced keys for any legacy pre-migration rows that
    // have not yet recorded daytona_key_name, plus 1 extra safety slot.
    const preserveCount = legacyNullCredCount > 0 ? legacyNullCredCount + 2 : 0;
    const candidates = unreferencedKortixKeys.slice(preserveCount);

    for (const oldKey of candidates) {
      if (!oldKey.name) continue;
      const createdMs = Date.parse(oldKey.createdAt || '');
      if (Number.isFinite(createdMs) && now - createdMs < STALE_UNREFERENCED_KEY_MIN_AGE_MS) {
        continue;
      }
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

export interface MintedDaytonaKey {
  apiKey: string;
  keyName: string;
  expiresAt: Date | null;
}

export async function mintPermanentDaytonaKey(
  jwt: string,
  orgId: string,
  flowId: string,
): Promise<MintedDaytonaKey> {
  const base = daytonaApiBaseUrl();
  await cleanupStaleKortixApiKeys(jwt, orgId);

  const ttlDays = config.KORTIX_DAYTONA_KEY_TTL_DAYS || 0;
  const expiresAt = ttlDays > 0 ? new Date(Date.now() + ttlDays * 86_400_000) : null;

  const shortTs = Date.now().toString(36);
  const shortFlow = flowId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'key';
  for (let attempt = 0; attempt < 3; attempt++) {
    const suffix = attempt === 0 ? '' : `-${randomBytes(2).toString('hex')}`;
    const keyName = `kortix-app-flow-${shortFlow}-${shortTs}${suffix}`;
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
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      }),
      signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
    });
    const text = await res.text();
    const isCollision =
      res.status === 409 ||
      (res.status === 400 && text.toLowerCase().includes('already exists'));
    if (isCollision && attempt < 2) continue;
    if (!res.ok) {
      logger.error('[daytona-onboarding] POST /api-keys failed', {
        orgId,
        status: res.status,
        body: text.slice(0, 300),
      });
      const classified = classifyDaytonaError(res.status, text);
      throw new DaytonaStructuredError(classified.code, classified.message, classified.httpStatus);
    }
    const created = JSON.parse(text) as { value?: string; name?: string; expiresAt?: string | null };
    if (!created.value || !created.value.startsWith('dtn_')) {
      throw new DaytonaStructuredError(
        'DAYTONA_RECONNECT_REQUIRED',
        'Daytona did not return a valid workspace key. Please try connecting again.',
        502,
      );
    }
    return {
      apiKey: created.value,
      keyName: created.name || keyName,
      expiresAt: created.expiresAt ? new Date(created.expiresAt) : expiresAt,
    };
  }
  throw new DaytonaStructuredError(
    'DAYTONA_RECONNECT_REQUIRED',
    'Could not create a Daytona workspace key after retrying. Please try again.',
    502,
  );
}

function toPollResultFromFlow(
  flow: typeof daytonaConnectFlows.$inferSelect,
): PollDaytonaConnectResult | null {
  if (flow.status === 'approved' && flow.claimToken && flow.daytonaOrgId) {
    if (flow.expiresAt.getTime() <= Date.now()) {
      return { status: 'expired' };
    }
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
  if (flow.terminalErrorCode) {
    const code = flow.terminalErrorCode as DaytonaOnboardingErrorCode;
    throw new DaytonaStructuredError(
      code,
      flow.terminalErrorMessage || HUMAN_ERROR_COPY[code] || HUMAN_ERROR_COPY.DAYTONA_SNAPSHOT_FAILED,
      flow.terminalErrorStatus ?? 400,
    );
  }
  if (flow.status === 'expired') {
    return { status: 'expired' };
  }
  return null;
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

    const immediate = toPollResultFromFlow(flow);
    if (immediate) return immediate;

    if (flow.expiresAt.getTime() <= Date.now()) {
      const expired = await db
        .update(daytonaConnectFlows)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(
          and(
            eq(daytonaConnectFlows.flowId, flowId),
            inArray(daytonaConnectFlows.status, ['pending', 'exchanging']),
          ),
        )
        .returning();
      if (expired.length > 0) return { status: 'expired' };
      const reread = await db
        .select()
        .from(daytonaConnectFlows)
        .where(eq(daytonaConnectFlows.flowId, flowId))
        .limit(1);
      if (reread[0]) {
        const after = toPollResultFromFlow(reread[0]);
        if (after) return after;
      }
      return { status: 'expired' };
    }

    // Strict conditional CAS: pending -> exchanging before calling WorkOS.
    // Reclaims stale 'exchanging' (>90s) only if a prior replica crashed mid-exchange.
    const staleExchangeCutoff = new Date(Date.now() - EXCHANGING_STALE_MS);
    const claimedForExchange = await db
      .update(daytonaConnectFlows)
      .set({ status: 'exchanging', updatedAt: new Date() })
      .where(
        and(
          eq(daytonaConnectFlows.flowId, flowId),
          or(
            eq(daytonaConnectFlows.status, 'pending'),
            and(
              eq(daytonaConnectFlows.status, 'exchanging'),
              lt(daytonaConnectFlows.updatedAt, staleExchangeCutoff),
            ),
          ),
        ),
      )
      .returning();

    if (claimedForExchange.length === 0) {
      // Another poller/replica already holds 'exchanging' or moved the flow to approved/claimed/expired.
      const reread = await db
        .select()
        .from(daytonaConnectFlows)
        .where(eq(daytonaConnectFlows.flowId, flowId))
        .limit(1);
      if (reread[0]) {
        const settled = toPollResultFromFlow(reread[0]);
        if (settled) return settled;
      }
      return { status: 'pending' };
    }

    const activeFlow = claimedForExchange[0]!;
    const cachedVerifyJwt = pendingEmailVerifyJwtCache.get(flowId);
    let jwt: string | undefined;
    if (cachedVerifyJwt && cachedVerifyJwt.expiresAt > Date.now()) {
      try {
        jwt = decryptDaytonaApiKey(flowId, cachedVerifyJwt);
      } catch {
        pendingEmailVerifyJwtCache.delete(flowId);
      }
    } else if (cachedVerifyJwt) {
      pendingEmailVerifyJwtCache.delete(flowId);
    }

    if (!jwt) {
      let tokRes: Response;
      try {
        const oidc = await getDaytonaWorkosOidcConfig();
        tokRes = await fetch(oidc.tokenEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: activeFlow.deviceCode,
            client_id: oidc.clientId,
          }).toString(),
          signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
        });
      } catch (networkErr) {
        // Revert exchanging -> pending on transient network failure before token consumption.
        await db
          .update(daytonaConnectFlows)
          .set({ status: 'pending', updatedAt: new Date() })
          .where(
            and(
              eq(daytonaConnectFlows.flowId, flowId),
              eq(daytonaConnectFlows.status, 'exchanging'),
            ),
          )
          .catch(() => {});
        throw networkErr;
      }

      const tokText = await tokRes.text();
      if (!tokRes.ok) {
        let errCode = '';
        try {
          errCode = String((JSON.parse(tokText) as { error?: string }).error || '');
        } catch {
          errCode = '';
        }
        if (errCode === 'authorization_pending' || errCode === 'slow_down') {
          await db
            .update(daytonaConnectFlows)
            .set({ status: 'pending', updatedAt: new Date() })
            .where(
              and(
                eq(daytonaConnectFlows.flowId, flowId),
                eq(daytonaConnectFlows.status, 'exchanging'),
              ),
            );
          return errCode === 'slow_down' ? { status: 'pending', slowDown: true } : { status: 'pending' };
        }
        if (
          errCode === 'expired_token' ||
          errCode === 'access_denied' ||
          errCode === 'invalid_grant'
        ) {
          // Conditional UPDATE: a late invalid_grant can NEVER overwrite 'approved' or 'claimed'.
          const updated = await db
            .update(daytonaConnectFlows)
            .set({ status: 'expired', updatedAt: new Date() })
            .where(
              and(
                eq(daytonaConnectFlows.flowId, flowId),
                inArray(daytonaConnectFlows.status, ['pending', 'exchanging']),
              ),
            )
            .returning();
          if (updated.length > 0) {
            return { status: 'expired' };
          }
          const reread = await db
            .select()
            .from(daytonaConnectFlows)
            .where(eq(daytonaConnectFlows.flowId, flowId))
            .limit(1);
          if (reread[0]) {
            const settled = toPollResultFromFlow(reread[0]);
            if (settled) return settled;
          }
          return { status: 'expired' };
        }
        // Transient WorkOS error: revert exchanging -> pending so next poll retries.
        await db
          .update(daytonaConnectFlows)
          .set({ status: 'pending', updatedAt: new Date() })
          .where(
            and(
              eq(daytonaConnectFlows.flowId, flowId),
              eq(daytonaConnectFlows.status, 'exchanging'),
            ),
          )
          .catch(() => {});
        const classified = classifyDaytonaError(tokRes.status, tokText);
        throw new DaytonaStructuredError(classified.code, classified.message, classified.httpStatus);
      }

      const tok = JSON.parse(tokText) as { access_token?: string };
      jwt = tok.access_token;
      if (!jwt) {
        await db
          .update(daytonaConnectFlows)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(
            and(
              eq(daytonaConnectFlows.flowId, flowId),
              eq(daytonaConnectFlows.status, 'exchanging'),
            ),
          )
          .catch(() => {});
        throw new DaytonaStructuredError(
          'DAYTONA_RECONNECT_REQUIRED',
          'Daytona authorization completed without an access token. Please reconnect.',
          502,
        );
      }
    }

    // WorkOS device_code is single-use: once we receive `jwt`, any subsequent call to
    // WorkOS with this device_code returns `invalid_grant`. Persist any post-JWT
    // Daytona refusal directly in DB (`terminal_error_*`) so every replica surfaces
    // the exact typed error instead of falsely reporting "expired".
    let org: DaytonaOrgSummary;
    let region: string;
    let mintedKey: MintedDaytonaKey;
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
        logger.warn('[daytona-onboarding] org is suspended during connect', {
          orgId: foundOrg.id,
          reason: reason || 'none',
        });
        if (/email/i.test(reason)) {
          throw new DaytonaStructuredError(
            'DAYTONA_EMAIL_UNVERIFIED',
            HUMAN_ERROR_COPY.DAYTONA_EMAIL_UNVERIFIED,
            403,
          );
        }
        throw new DaytonaStructuredError(
          'DAYTONA_ORG_SUSPENDED',
          HUMAN_ERROR_COPY.DAYTONA_ORG_SUSPENDED,
          402,
        );
      }
      org = foundOrg;
      region = await ensureDefaultRegionOnOrg(jwt, org.id, org.defaultRegionId);
      mintedKey = await mintPermanentDaytonaKey(jwt, org.id, flowId);
      pendingEmailVerifyJwtCache.delete(flowId);
    } catch (postJwtErr) {
      const structured =
        postJwtErr instanceof DaytonaStructuredError
          ? postJwtErr
          : (() => {
              const classified = classifyDaytonaError(postJwtErr);
              return new DaytonaStructuredError(
                classified.code,
                classified.message,
                classified.httpStatus,
              );
            })();
      if (structured.code === 'DAYTONA_EMAIL_UNVERIFIED') {
        const encJwt = encryptDaytonaApiKey(flowId, jwt);
        lruSet(
          pendingEmailVerifyJwtCache,
          flowId,
          { ...encJwt, expiresAt: Date.now() + 20 * 60_000 },
          500,
        );
        await db
          .update(daytonaConnectFlows)
          .set({
            status: 'pending',
            expiresAt: new Date(Math.max(activeFlow.expiresAt.getTime(), Date.now() + 20 * 60_000)),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(daytonaConnectFlows.flowId, flowId),
              eq(daytonaConnectFlows.status, 'exchanging'),
            ),
          )
          .catch(() => {});
        return {
          status: 'email_verification_required',
          errorCode: 'DAYTONA_EMAIL_UNVERIFIED',
          message: structured.message,
        };
      }
      pendingEmailVerifyJwtCache.delete(flowId);
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
      await db
        .update(daytonaConnectFlows)
        .set({
          status: 'expired',
          terminalErrorCode: structured.code,
          terminalErrorMessage: structured.message,
          terminalErrorStatus: structured.httpStatus,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(daytonaConnectFlows.flowId, flowId),
            eq(daytonaConnectFlows.status, 'exchanging'),
          ),
        )
        .catch(() => {});
      throw structured;
    }

    const encrypted = encryptDaytonaApiKey(flowId, mintedKey.apiKey);
    const claimToken = randomBytes(32).toString('base64url');
    // Extend TTL (default 60m via KORTIX_DAYTONA_CLAIM_TTL_MINUTES) so slow signups / email verification never lose their claim.
    const claimExpiresAt = new Date(Date.now() + getDaytonaClaimTtlMs());

    const approvedRows = await db
      .update(daytonaConnectFlows)
      .set({
        status: 'approved',
        encryptedApiKey: encrypted.encryptedApiKey,
        encryptionIv: encrypted.encryptionIv,
        encryptionTag: encrypted.encryptionTag,
        daytonaKeyName: mintedKey.keyName,
        daytonaOrgId: org.id,
        daytonaRegion: region,
        claimToken,
        expiresAt: claimExpiresAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(daytonaConnectFlows.flowId, flowId),
          eq(daytonaConnectFlows.status, 'exchanging'),
        ),
      )
      .returning();

    if (approvedRows.length === 0) {
      const reread = await db
        .select()
        .from(daytonaConnectFlows)
        .where(eq(daytonaConnectFlows.flowId, flowId))
        .limit(1);
      if (reread[0]) {
        const settled = toPollResultFromFlow(reread[0]);
        if (settled) return settled;
      }
    }

    // Fire-and-forget: kick off the GHCR snapshot pull strictly asynchronously
    // IMMEDIATELY at Daytona approval, so /poll never blocks and the image is
    // already warming before Step 2 finishes.
    setImmediate(() => {
      void ensureUserSnapshot({
        apiKey: mintedKey.apiKey,
        daytonaOrgId: org.id,
        daytonaRegion: region,
      }).catch((err) => {
        logger.warn('[daytona-onboarding] background pre-claim snapshot pull failed', {
          orgId: org.id,
          error: err instanceof Error ? err.message : String(err),
        });
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
  previousOrgId?: string | null;
  orgSwitched?: boolean;
  warning?: string | null;
}

function buildOrgSwitchWarning(previousOrgId: string, newOrgId: string): string {
  return (
    `Connected a different Daytona organization (${newOrgId.slice(0, 8)}..., replacing ${previousOrgId.slice(0, 8)}...). ` +
    'Sessions created under your previous Daytona workspace will remain unreachable until you reconnect that account.'
  );
}

export async function claimDaytonaConnect(
  userId: string,
  claimToken: string,
): Promise<DaytonaOnboardingStatusResult> {
  const now = new Date();
  const normalizedToken = claimToken.trim();
  const rows = await db
    .select()
    .from(daytonaConnectFlows)
    .where(eq(daytonaConnectFlows.claimToken, normalizedToken))
    .limit(1);
  const flow = rows[0];

  // Idempotent re-claim for the SAME authenticated user (e.g. /auth/callback +
  // post-auth DaytonaOnboardingGate or two open tabs racing the same claimToken),
  // while strictly rejecting cross-user replay (single-use per user).
  if (flow && flow.status === 'claimed') {
    const existing = await db
      .select({ daytonaOrgId: userDaytonaCredentials.daytonaOrgId })
      .from(userDaytonaCredentials)
      .where(eq(userDaytonaCredentials.userId, userId))
      .limit(1);
    if (existing[0] && existing[0].daytonaOrgId === flow.daytonaOrgId) {
      return getDaytonaOnboardingStatus(userId);
    }
    throw new DaytonaStructuredError(
      'DAYTONA_RECONNECT_REQUIRED',
      'This Daytona approval link has already been used. Reconnect Daytona in one tap.',
      409,
      false,
    );
  }

  if (
    !flow ||
    flow.status !== 'approved' ||
    flow.expiresAt.getTime() <= now.getTime() ||
    !flow.encryptedApiKey ||
    !flow.encryptionIv ||
    !flow.encryptionTag ||
    !flow.daytonaOrgId
  ) {
    // Returning / already-connected user carrying a stale pending-claim entry in
    // browser storage must NEVER be prompted to connect Daytona a second time.
    const currentStatus = await getDaytonaOnboardingStatus(userId).catch(() => null);
    if (currentStatus?.connected && !currentStatus.reconnectRequired) {
      return currentStatus;
    }
    throw new DaytonaStructuredError(
      'DAYTONA_RECONNECT_REQUIRED',
      'Your Daytona approval expired before sign-in finished. Tap Reconnect Daytona to continue.',
      410,
      false,
    );
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
  const ttlDays = config.KORTIX_DAYTONA_KEY_TTL_DAYS || 0;
  const keyExpiresAt = ttlDays > 0 ? new Date(Date.now() + ttlDays * 86_400_000) : null;

  let previousOrgId: string | null = null;
  let orgSwitched = false;
  let lostConcurrentSameUserRace = false;

  // Atomically claim the flow (clearing its temporary key copy) and bind to user_daytona_credentials.
  await db.transaction(async (tx) => {
    const existingCreds = await tx
      .select({ daytonaOrgId: userDaytonaCredentials.daytonaOrgId })
      .from(userDaytonaCredentials)
      .where(eq(userDaytonaCredentials.userId, userId))
      .limit(1);
    const priorOrg = existingCreds[0]?.daytonaOrgId ?? null;
    if (priorOrg && priorOrg !== flow.daytonaOrgId) {
      previousOrgId = priorOrg;
      orgSwitched = true;
    }

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
      lostConcurrentSameUserRace = true;
      return;
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
        daytonaKeyName: flow.daytonaKeyName ?? null,
        daytonaKeyExpiresAt: keyExpiresAt,
        previousDaytonaOrgId: orgSwitched ? previousOrgId : null,
        previousOrgReplacedAt: orgSwitched ? now : null,
        snapshotName: initialSnapshotName,
        snapshotStatus: 'pulling',
        snapshotError: null,
        snapshotAttempts: 0,
        snapshotNextRetryAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userDaytonaCredentials.userId,
        set: {
          encryptedApiKey: userEncrypted.encryptedApiKey,
          encryptionIv: userEncrypted.encryptionIv,
          encryptionTag: userEncrypted.encryptionTag,
          daytonaOrgId: flow.daytonaOrgId!,
          daytonaRegion: region,
          daytonaKeyName: flow.daytonaKeyName ?? null,
          daytonaKeyExpiresAt: keyExpiresAt,
          ...(orgSwitched
            ? {
                previousDaytonaOrgId: previousOrgId,
                previousOrgReplacedAt: now,
              }
            : {}),
          snapshotName: initialSnapshotName,
          snapshotStatus: 'pulling',
          snapshotError: null,
          snapshotAttempts: 0,
          snapshotNextRetryAt: null,
          updatedAt: now,
        },
      });
  });

  if (lostConcurrentSameUserRace) {
    const afterRace = await db
      .select({ daytonaOrgId: userDaytonaCredentials.daytonaOrgId })
      .from(userDaytonaCredentials)
      .where(eq(userDaytonaCredentials.userId, userId))
      .limit(1);
    if (afterRace[0] && afterRace[0].daytonaOrgId === flow.daytonaOrgId) {
      return getDaytonaOnboardingStatus(userId);
    }
    throw new DaytonaStructuredError(
      'DAYTONA_RECONNECT_REQUIRED',
      'This Daytona approval link has already been used. Reconnect Daytona in one tap.',
      409,
      false,
    );
  }

  if (orgSwitched && previousOrgId) {
    logger.warn('[daytona-onboarding] user switched Daytona organization during claim', {
      userId,
      previousOrgId,
      newOrgId: flow.daytonaOrgId,
    });
  }

  invalidateUserDaytonaCache(userId);
  const warning = orgSwitched && previousOrgId ? buildOrgSwitchWarning(previousOrgId, flow.daytonaOrgId) : null;

  // Trigger snapshot pull strictly asynchronously so /claim returns immediately.
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
      previousOrgId,
      orgSwitched,
      warning,
    };
  }

  setImmediate(() => {
    void ensureUserSnapshot({
      userId,
      apiKey: plaintextApiKey,
      daytonaOrgId: flow.daytonaOrgId!,
      daytonaRegion: region,
    }).catch((err) => {
      logger.warn('[daytona-onboarding] post-claim background snapshot pull failed', {
        userId,
        orgId: flow.daytonaOrgId,
        error: err instanceof Error ? err.message : String(err),
      });
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
    previousOrgId,
    orgSwitched,
    warning,
  };
}

/**
 * Read-only Daytona onboarding status (`GET /v1/onboarding/daytona/status`).
 *
 * Strictly read-only against Daytona: NEVER calls POST /snapshots,
 * DELETE /snapshots, POST /activate, or PATCH /default-region. Use
 * `POST /v1/onboarding/daytona/retry` or the bounded worker job to mutate/retry.
 */
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
      previousOrgId: null,
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
      previousOrgId: null,
    };
  }

  let expectedSnapshotName: string | null = null;
  try {
    const pinnedImg = getPinnedGhcrSandboxImage();
    expectedSnapshotName = pinnedImg ? deriveSnapshotNameForImage(pinnedImg) : null;
  } catch (cfgErr) {
    const classified = classifyDaytonaError(cfgErr);
    return {
      connected: true,
      orgId: row.daytonaOrgId,
      region: row.daytonaRegion,
      snapshotName: row.snapshotName,
      snapshotStatus: 'failed',
      snapshotErrorCode: classified.code,
      snapshotError: classified.message,
      reconnectRequired: false,
      previousOrgId: row.previousDaytonaOrgId ?? null,
    };
  }

  // Only poll read-only GET /snapshots/:name while snapshot is actively transitioning.
  const shouldObserveReadOnly =
    row.snapshotStatus === 'pending' ||
    row.snapshotStatus === 'pulling' ||
    (expectedSnapshotName !== null && row.snapshotName !== expectedSnapshotName);

  if (shouldObserveReadOnly) {
    try {
      const ctx = await getUserDaytonaContext(userId);
      if (ctx) {
        const snap = await inspectUserSnapshotReadOnly({
          userId,
          apiKey: ctx.apiKey,
          daytonaOrgId: ctx.daytonaOrgId,
        });
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
            previousOrgId: row.previousDaytonaOrgId ?? null,
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
          previousOrgId: row.previousDaytonaOrgId ?? null,
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
          previousOrgId: row.previousDaytonaOrgId ?? null,
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
    previousOrgId: row.previousDaytonaOrgId ?? null,
  };
}

/**
 * Explicit user-triggered snapshot create/activate/retry (`POST /v1/onboarding/daytona/retry`).
 * Resets the automatic retry counter and triggers one bounded create/activate attempt.
 */
export async function retryUserDaytonaSnapshot(
  userId: string,
): Promise<DaytonaOnboardingStatusResult> {
  const resolution = await resolveUserDaytonaContext(userId);
  if (resolution.kind === 'not_connected') {
    throw new DaytonaNotConnectedError();
  }
  if (resolution.kind === 'reconnect_required') {
    throw new DaytonaReconnectRequiredError(resolution.message);
  }
  if (resolution.kind === 'error') {
    throw resolution.cause instanceof Error
      ? resolution.cause
      : new Error(resolution.message);
  }

  const { ctx } = resolution;
  const snap = await ensureUserSnapshot({
    userId: ctx.userId,
    apiKey: ctx.apiKey,
    daytonaOrgId: ctx.daytonaOrgId,
    daytonaRegion: ctx.daytonaRegion,
    allowDeleteErrored: true,
    resetAttempts: true,
  });

  return {
    connected: true,
    orgId: ctx.daytonaOrgId,
    region: ctx.daytonaRegion,
    snapshotName: snap.snapshotName || ctx.snapshotName,
    snapshotStatus: snap.snapshotStatus,
    snapshotErrorCode: snap.snapshotErrorCode,
    snapshotError: snap.snapshotError,
    reconnectRequired: Boolean(snap.reconnectRequired),
  };
}

const NON_RETRIABLE_SNAPSHOT_ERRORS = new Set<string>([
  'DAYTONA_RECONNECT_REQUIRED',
  'DAYTONA_ORG_SUSPENDED',
  'DAYTONA_EMAIL_UNVERIFIED',
  'DAYTONA_REGION_REQUIRED',
  'DAYTONA_SNAPSHOT_CONFIG_INVALID',
]);

/**
 * Bounded leader-only background worker retry for due failed/pending/inactive
 * user snapshots (respects MAX_SNAPSHOT_ATTEMPTS and exponential backoff).
 */
export async function retryDueDaytonaSnapshotsOnce(): Promise<{
  checked: number;
  retried: number;
  activated: number;
}> {
  if (!hasDatabase) return { checked: 0, retried: 0, activated: 0 };
  let imageRef: string | null = null;
  try {
    imageRef = getPinnedGhcrSandboxImage();
  } catch {
    return { checked: 0, retried: 0, activated: 0 };
  }
  if (!imageRef) return { checked: 0, retried: 0, activated: 0 };

  const now = new Date();
  const rows = await db
    .select()
    .from(userDaytonaCredentials)
    .where(
      and(
        inArray(userDaytonaCredentials.snapshotStatus, ['pending', 'failed', 'inactive']),
        or(
          sql`${userDaytonaCredentials.snapshotAttempts} IS NULL`,
          lt(userDaytonaCredentials.snapshotAttempts, MAX_SNAPSHOT_ATTEMPTS),
        ),
        or(
          sql`${userDaytonaCredentials.snapshotNextRetryAt} IS NULL`,
          lt(userDaytonaCredentials.snapshotNextRetryAt, now),
        ),
      ),
    )
    .limit(10);

  let retried = 0;
  let activated = 0;
  const seenOrgs = new Set<string>();
  for (const row of rows) {
    if (seenOrgs.has(row.daytonaOrgId)) continue;
    if (row.snapshotError && NON_RETRIABLE_SNAPSHOT_ERRORS.has(row.snapshotError)) continue;
    seenOrgs.add(row.daytonaOrgId);
    const resolved = await resolveUserDaytonaContext(row.userId);
    if (resolved.kind !== 'user') continue;
    try {
      const res = await ensureUserSnapshot({
        userId: resolved.ctx.userId,
        apiKey: resolved.ctx.apiKey,
        daytonaOrgId: resolved.ctx.daytonaOrgId,
        daytonaRegion: resolved.ctx.daytonaRegion,
        allowDeleteErrored: true,
      });
      retried += 1;
      if (res.snapshotStatus === 'active') activated += 1;
    } catch {
      // Errors are persisted on the row by ensureUserSnapshot.
    }
  }
  return { checked: rows.length, retried, activated };
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
    name?: string;
    organizationId?: string;
    permissions?: string[];
    expiresAt?: string | null;
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

  const detectedKeyName = typeof curBody.name === 'string' && curBody.name.trim() ? curBody.name.trim() : null;
  const detectedKeyExpiresAt =
    typeof curBody.expiresAt === 'string' && curBody.expiresAt ? new Date(curBody.expiresAt) : null;

  const encrypted = encryptDaytonaApiKey(userId, apiKey);
  const pinnedImg = getPinnedGhcrSandboxImage();
  const initialSnapshotName = pinnedImg ? deriveSnapshotNameForImage(pinnedImg) : null;
  const now = new Date();

  const existingCreds = await db
    .select({ daytonaOrgId: userDaytonaCredentials.daytonaOrgId })
    .from(userDaytonaCredentials)
    .where(eq(userDaytonaCredentials.userId, userId))
    .limit(1);
  const priorOrg = existingCreds[0]?.daytonaOrgId ?? null;
  const orgSwitched = Boolean(priorOrg && priorOrg !== detectedOrgId);
  const previousOrgId = orgSwitched ? priorOrg : null;

  await db
    .insert(userDaytonaCredentials)
    .values({
      userId,
      encryptedApiKey: encrypted.encryptedApiKey,
      encryptionIv: encrypted.encryptionIv,
      encryptionTag: encrypted.encryptionTag,
      daytonaOrgId: detectedOrgId,
      daytonaRegion: detectedRegion,
      daytonaKeyName: detectedKeyName,
      daytonaKeyExpiresAt: detectedKeyExpiresAt,
      previousDaytonaOrgId: previousOrgId,
      previousOrgReplacedAt: orgSwitched ? now : null,
      snapshotName: initialSnapshotName,
      snapshotStatus: 'pulling',
      snapshotError: null,
      snapshotAttempts: 0,
      snapshotNextRetryAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userDaytonaCredentials.userId,
      set: {
        encryptedApiKey: encrypted.encryptedApiKey,
        encryptionIv: encrypted.encryptionIv,
        encryptionTag: encrypted.encryptionTag,
        daytonaOrgId: detectedOrgId,
        daytonaRegion: detectedRegion,
        daytonaKeyName: detectedKeyName,
        daytonaKeyExpiresAt: detectedKeyExpiresAt,
        ...(orgSwitched
          ? {
              previousDaytonaOrgId: previousOrgId,
              previousOrgReplacedAt: now,
            }
          : {}),
        snapshotName: initialSnapshotName,
        snapshotStatus: 'pulling',
        snapshotError: null,
        snapshotAttempts: 0,
        snapshotNextRetryAt: null,
        updatedAt: now,
      },
    });

  if (orgSwitched && previousOrgId) {
    logger.warn('[daytona-onboarding] user switched Daytona organization via manual-key', {
      userId,
      previousOrgId,
      newOrgId: detectedOrgId,
    });
  }

  invalidateUserDaytonaCache(userId);
  const warning = orgSwitched && previousOrgId ? buildOrgSwitchWarning(previousOrgId, detectedOrgId) : null;

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
      previousOrgId,
      orgSwitched,
      warning,
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
      logger.warn('[daytona-onboarding] background manual-key snapshot pull failed', {
        userId,
        orgId: detectedOrgId,
        error: err instanceof Error ? err.message : String(err),
      });
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
    previousOrgId,
    orgSwitched,
    warning,
  };
}

async function revokeDaytonaApiKeyBestEffort(
  apiKey: string,
  orgId: string,
  keyName: string | null,
): Promise<{ revoked: boolean; status: number | null }> {
  if (!keyName) return { revoked: false, status: null };
  const base = daytonaApiBaseUrl();
  try {
    const res = await fetch(`${base}/api-keys/${encodeURIComponent(keyName)}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Daytona-Organization-ID': orgId,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
    });
    if (res.ok || res.status === 404) {
      return { revoked: true, status: res.status };
    }
    logger.warn('[daytona-onboarding] Daytona API key revoke returned non-ok status', {
      orgId,
      keyName,
      status: res.status,
    });
    return { revoked: false, status: res.status };
  } catch (err) {
    logger.warn('[daytona-onboarding] Daytona API key revoke request failed', {
      orgId,
      keyName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { revoked: false, status: null };
  }
}

export interface DisconnectDaytonaResult {
  disconnected: boolean;
  stoppedSandboxes: number;
  keyRevoked: boolean;
}

/**
 * Cleanly disconnect a user's Daytona account:
 * 1. Stop (never delete) all active/provisioning sandboxes owned by this user
 *    in their Daytona org.
 * 2. Attempt to revoke their Daytona API key via Daytona API.
 * 3. Delete the user_daytona_credentials row and clear all replica caches.
 */
export async function disconnectUserDaytona(userId: string): Promise<DisconnectDaytonaResult> {
  if (!hasDatabase) {
    invalidateUserDaytonaCache(userId);
    return { disconnected: true, stoppedSandboxes: 0, keyRevoked: false };
  }

  let stoppedSandboxes = 0;
  let keyRevoked = false;

  const rows = await db
    .select()
    .from(userDaytonaCredentials)
    .where(eq(userDaytonaCredentials.userId, userId))
    .limit(1);
  const row = rows[0];

  if (row) {
    let apiKey: string | null = null;
    try {
      apiKey = decryptDaytonaApiKey(userId, {
        encryptedApiKey: row.encryptedApiKey,
        encryptionIv: row.encryptionIv,
        encryptionTag: row.encryptionTag,
      });
    } catch {
      apiKey = null;
    }

    if (apiKey) {
      // 1. Stop (never delete) this user's active Daytona sandboxes.
      try {
        const activeRows = await db
          .select({ externalId: sessionSandboxes.externalId })
          .from(sessionSandboxes)
          .where(
            and(
              eq(sessionSandboxes.provider, 'daytona'),
              inArray(sessionSandboxes.status, ['active', 'provisioning']),
              isNotNull(sessionSandboxes.externalId),
              or(
                sql`${sessionSandboxes.metadata}->>'daytonaOwnerUserId' = ${userId}`,
                sql`${sessionSandboxes.metadata}->>'provisionedBy' = ${userId}`,
              ),
              or(
                sql`${sessionSandboxes.metadata}->>'daytonaOrgId' = ${row.daytonaOrgId}`,
                sql`${sessionSandboxes.metadata}->>'daytonaOrgId' IS NULL`,
              ),
            ),
          )
          .limit(50);

        for (const sb of activeRows) {
          if (!sb.externalId) continue;
          const stopped = await stopDaytonaSandboxById(sb.externalId, apiKey);
          if (stopped) stoppedSandboxes += 1;
        }
      } catch (err) {
        logger.warn('[daytona-onboarding] failed stopping sandboxes during disconnect', {
          userId,
          orgId: row.daytonaOrgId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 2. Resolve key name if missing (legacy row), then attempt revocation.
      let keyName = row.daytonaKeyName ?? null;
      if (!keyName) {
        try {
          const curRes = await fetch(`${daytonaApiBaseUrl()}/api-keys/current`, {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS),
          });
          if (curRes.ok) {
            const curBody = (await curRes.json().catch(() => ({}))) as { name?: string };
            if (typeof curBody.name === 'string' && curBody.name.trim()) {
              keyName = curBody.name.trim();
            }
          }
        } catch {
          // Best-effort lookup only.
        }
      }
      const revokeRes = await revokeDaytonaApiKeyBestEffort(apiKey, row.daytonaOrgId, keyName);
      keyRevoked = revokeRes.revoked;
    }

    // 3. Delete credentials row and clear caches.
    await db
      .delete(userDaytonaCredentials)
      .where(eq(userDaytonaCredentials.userId, userId));
  }

  invalidateUserDaytonaCache(userId);
  return { disconnected: true, stoppedSandboxes, keyRevoked };
}

/**
 * Leader-only reaper for expired/unclaimed Daytona connect flows:
 * - Revokes unclaimed keys (if not referenced by user_daytona_credentials)
 * - Scrubs encrypted temporary keys and transitions expired flows -> 'expired'
 * - Recovers stuck 'exchanging' flows older than EXCHANGING_STALE_MS.
 */
export async function reapExpiredDaytonaConnectFlowsOnce(): Promise<{
  expired: number;
  keysRevoked: number;
  recoveredExchanging: number;
}> {
  if (!hasDatabase) return { expired: 0, keysRevoked: 0, recoveredExchanging: 0 };
  const now = new Date();
  let expired = 0;
  let keysRevoked = 0;
  let recoveredExchanging = 0;

  // 1. Reclaim stuck 'exchanging' flows whose replica died before completion.
  const staleExchangeCutoff = new Date(Date.now() - EXCHANGING_STALE_MS);
  const stuckRows = await db
    .update(daytonaConnectFlows)
    .set({ status: 'pending', updatedAt: now })
    .where(
      and(
        eq(daytonaConnectFlows.status, 'exchanging'),
        lt(daytonaConnectFlows.updatedAt, staleExchangeCutoff),
        gt(daytonaConnectFlows.expiresAt, now),
      ),
    )
    .returning({ flowId: daytonaConnectFlows.flowId });
  recoveredExchanging = stuckRows.length;

  // 2. Find expired pending/exchanging/approved flows.
  const expiredFlows = await db
    .select()
    .from(daytonaConnectFlows)
    .where(
      and(
        inArray(daytonaConnectFlows.status, ['pending', 'exchanging', 'approved']),
        lt(daytonaConnectFlows.expiresAt, now),
      ),
    )
    .limit(50);

  for (const flow of expiredFlows) {
    if (
      flow.status === 'approved' &&
      flow.encryptedApiKey &&
      flow.encryptionIv &&
      flow.encryptionTag &&
      flow.daytonaOrgId &&
      flow.daytonaKeyName
    ) {
      // Never revoke a key that was somehow already claimed into user_daytona_credentials.
      const stillReferenced = await db
        .select({ userId: userDaytonaCredentials.userId })
        .from(userDaytonaCredentials)
        .where(
          and(
            eq(userDaytonaCredentials.daytonaOrgId, flow.daytonaOrgId),
            eq(userDaytonaCredentials.daytonaKeyName, flow.daytonaKeyName),
          ),
        )
        .limit(1);
      if (stillReferenced.length === 0) {
        try {
          const plaintext = decryptDaytonaApiKey(flow.flowId, {
            encryptedApiKey: flow.encryptedApiKey,
            encryptionIv: flow.encryptionIv,
            encryptionTag: flow.encryptionTag,
          });
          const res = await revokeDaytonaApiKeyBestEffort(
            plaintext,
            flow.daytonaOrgId,
            flow.daytonaKeyName,
          );
          if (res.revoked) keysRevoked += 1;
        } catch {
          // Best-effort decryption/revocation; still scrub and expire below.
        }
      }
    }

    const updated = await db
      .update(daytonaConnectFlows)
      .set({
        status: 'expired',
        encryptedApiKey: null,
        encryptionIv: null,
        encryptionTag: null,
        claimToken: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(daytonaConnectFlows.flowId, flow.flowId),
          inArray(daytonaConnectFlows.status, ['pending', 'exchanging', 'approved']),
        ),
      )
      .returning({ flowId: daytonaConnectFlows.flowId });
    if (updated.length > 0) expired += 1;
  }

  return { expired, keysRevoked, recoveredExchanging };
}
