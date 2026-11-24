import { Daytona } from '@daytonaio/sdk';
import { config } from '../config';
import { configuredTimeoutMs } from './with-timeout';

let daytonaClient: Daytona | null = null;

/**
 * Get singleton Daytona SDK client.
 * Used for sandbox provisioning.
 */
export function getDaytona(): Daytona {
  if (!daytonaClient) {
    if (!config.DAYTONA_API_KEY) {
      throw new Error('Missing DAYTONA_API_KEY');
    }

    daytonaClient = new Daytona({
      apiKey: config.DAYTONA_API_KEY,
      apiUrl: config.DAYTONA_SERVER_URL || undefined,
      target: config.DAYTONA_TARGET || undefined,
    });
  }

  return daytonaClient;
}

/**
 * Check if Daytona is configured.
 */
export function isDaytonaConfigured(): boolean {
  return !!config.DAYTONA_API_KEY;
}

export interface DaytonaSnapshotSummary {
  id: string;
  name: string;
  state: string;
  createdAt: string | null;
  /** Last time a sandbox was created from this snapshot (null = never). */
  lastUsedAt: string | null;
  /** Regions the snapshot is bootable in (e.g. ['us','eu'] or ['experimental']). */
  regionIds: string[];
}

function daytonaApiBase(): string {
  return (config.DAYTONA_SERVER_URL || 'https://app.daytona.io/api').replace(/\/+$/, '');
}

// Same class of bug as the Daytona SDK's own 24h axios default (see
// platform/providers/daytona.ts for the full incident writeup): bare
// `fetch()` has NO default timeout. Every REST call below runs inside the
// maintenance loop's blast radius — snapshots/quota-gc.ts's
// reconcileSnapshotQuota() awaits two of them inside maintenance.ts's
// Promise.all every cycle, and the disk-quota guard (wired in
// platform/providers/daytona.ts) runs the other two from the emergency
// archive sweep — an unbounded hang here wedges that machinery exactly the
// same way.
const DAYTONA_REST_CALL_TIMEOUT_MS = configuredTimeoutMs('KORTIX_DAYTONA_CALL_TIMEOUT_MS', 20_000, 1_000);

function resolveDaytonaKey(apiKeyOverride?: string): string {
  if (apiKeyOverride !== undefined) {
    const trimmed = apiKeyOverride.trim();
    if (!trimmed) throw new Error('Missing user Daytona API key');
    return trimmed;
  }
  const key = config.DAYTONA_API_KEY;
  if (!key) throw new Error('Missing DAYTONA_API_KEY');
  return key;
}

function resolveOptionalDaytonaKey(apiKeyOverride?: string): string {
  if (apiKeyOverride !== undefined) {
    return apiKeyOverride.trim();
  }
  return config.DAYTONA_API_KEY || '';
}

/**
 * List every snapshot in the org via the REST API (the SDK exposes no stable
 * paginated list). Walks all pages. Used by snapshot reconciliation to detect
 * orphans and enforce the org-wide snapshot quota. Throws on transport / auth
 * failure so callers can skip destructive reconciliation when the view is
 * incomplete (never delete based on a partial list).
 */
export async function listDaytonaSnapshots(apiKeyOverride?: string): Promise<DaytonaSnapshotSummary[]> {
  const apiKey = resolveDaytonaKey(apiKeyOverride);
  const base = daytonaApiBase();
  const out: DaytonaSnapshotSummary[] = [];
  let page = 1;
  // Hard cap on pages so a misbehaving API can't spin us forever.
  for (let guard = 0; guard < 100; guard++) {
    const res = await fetch(`${base}/snapshots?limit=200&page=${page}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DAYTONA_REST_CALL_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Daytona list snapshots failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      items?: Array<{ id: string; name: string; state?: string; createdAt?: string; created?: string; lastUsedAt?: string; regionIds?: string[] }>;
      totalPages?: number;
    };
    for (const it of body.items ?? []) {
      out.push({
        id: it.id,
        name: it.name,
        state: it.state ?? 'unknown',
        createdAt: it.createdAt ?? it.created ?? null,
        lastUsedAt: it.lastUsedAt ?? null,
        regionIds: Array.isArray(it.regionIds) ? it.regionIds : [],
      });
    }
    const totalPages = body.totalPages ?? 1;
    if (page >= totalPages) break;
    page += 1;
  }
  return out;
}

/**
 * Delete a snapshot by its Daytona id. Returns true on success or when the
 * snapshot is already gone (404); false on any other failure. Best-effort —
 * never throws so batch reconciliation can continue past a single bad row.
 */
export async function deleteDaytonaSnapshotById(id: string, apiKeyOverride?: string): Promise<boolean> {
  const apiKey = resolveOptionalDaytonaKey(apiKeyOverride);
  if (!apiKey) return false;
  try {
    const res = await fetch(`${daytonaApiBase()}/snapshots/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DAYTONA_REST_CALL_TIMEOUT_MS),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/**
 * The exact substring Daytona's REST API returns when the ORG (shared across
 * every environment — prod/dev/staging/laptops) has exceeded its total
 * sandbox disk allocation. Matched case-insensitively against any thrown
 * error's message so both the SDK's typed DaytonaValidationError and a raw
 * fetch failure are recognized the same way — see disk-quota-guard.ts, the
 * live incident (2026-07-02) this backstops: every create/resume org-wide
 * failed once non-archived disk hit the 40000GiB cap.
 */
const DISK_QUOTA_ERROR_SUBSTRING = 'total disk limit exceeded';

export function isDaytonaDiskQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes(DISK_QUOTA_ERROR_SUBSTRING);
}

/**
 * Matches Daytona org-wide compute/concurrency quota errors (e.g. "Total memory
 * limit exceeded. Maximum allowed: 10GiB." or "Total CPU limit exceeded").
 * Explicitly excludes disk quota errors (which also include the footer
 * "To increase concurrency limits...").
 */
export function isDaytonaComputeQuotaError(err: unknown): boolean {
  if (isDaytonaDiskQuotaError(err)) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('total memory limit exceeded') ||
    msg.includes('total cpu limit exceeded') ||
    msg.includes('concurrency limit') ||
    (msg.includes('memory limit') && msg.includes('maximum allowed'))
  );
}

export interface DaytonaStartedSandboxSummary {
  id: string;
  memory: number;
  cpu: number;
  lastActivityAt: string | null;
  createdAt: string | null;
  managed: boolean;
}

/**
 * List org-wide STARTED Daytona sandboxes, oldest activity first, so the
 * compute-quota guard can evict idle Kortix sandboxes when RAM/CPU hits the
 * org tier cap (e.g. 10 GiB = max 2 x 4 GiB sandboxes).
 */
export async function listStartedDaytonaSandboxesOldestFirst(
  maxItems: number,
  apiKeyOverride?: string,
): Promise<DaytonaStartedSandboxSummary[]> {
  const apiKey = resolveDaytonaKey(apiKeyOverride);
  const base = daytonaApiBase();
  const out: DaytonaStartedSandboxSummary[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20 && out.length < maxItems; guard++) {
    const url = new URL(`${base}/sandbox`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('states', 'started');
    url.searchParams.set('sort', 'lastActivityAt');
    url.searchParams.set('order', 'asc');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DAYTONA_REST_CALL_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Daytona list started sandboxes failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      items?: Array<{
        id: string;
        memory?: number;
        cpu?: number;
        lastActivityAt?: string;
        createdAt?: string;
        labels?: Record<string, string>;
      }>;
      nextCursor?: string | null;
    };
    const items = body.items ?? [];
    for (const it of items) {
      out.push({
        id: it.id,
        memory: it.memory ?? 4,
        cpu: it.cpu ?? 2,
        lastActivityAt: it.lastActivityAt ?? null,
        createdAt: it.createdAt ?? null,
        managed: Boolean(it.labels?.['kortix.managed']),
      });
      if (out.length >= maxItems) break;
    }
    cursor = body.nextCursor ?? null;
    if (!cursor || items.length === 0) break;
  }
  return out;
}

/**
 * Stop a running Daytona sandbox via REST API (reversible — preserves disk and
 * session log; frees CPU/RAM immediately once stopped).
 */
export async function stopDaytonaSandboxById(id: string, apiKeyOverride?: string): Promise<boolean> {
  const apiKey = resolveOptionalDaytonaKey(apiKeyOverride);
  if (!apiKey) return false;
  try {
    const res = await fetch(`${daytonaApiBase()}/sandbox/${id}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DAYTONA_REST_CALL_TIMEOUT_MS),
    });
    return res.ok || res.status === 404 || res.status === 409;
  } catch {
    return false;
  }
}

/** Read a Daytona sandbox's current state string via REST API, or null on 404/error. */
export async function getDaytonaSandboxStateById(id: string, apiKeyOverride?: string): Promise<string | null> {
  const apiKey = resolveOptionalDaytonaKey(apiKeyOverride);
  if (!apiKey) return null;
  try {
    const res = await fetch(`${daytonaApiBase()}/sandbox/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DAYTONA_REST_CALL_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { state?: string };
    return typeof body.state === 'string' ? body.state.toLowerCase() : null;
  } catch {
    return null;
  }
}

export interface DaytonaStoppedSandboxSummary {
  id: string;
  disk: number;
  lastActivityAt: string | null;
  managed?: boolean;
}

/**
 * Page through org-wide STOPPED (not yet archived) sandboxes, oldest activity
 * first — the safest and highest-yield candidates for an emergency archive
 * sweep (see disk-quota-guard.ts). Unscoped by environment labels
 * deliberately: the disk quota is ORG-wide, so relief has to be too. Bounded
 * by `maxItems` so a pass can never balloon into a full-org scan.
 */
export async function listStoppedDaytonaSandboxesOldestFirst(
  maxItems: number,
  apiKeyOverride?: string,
): Promise<DaytonaStoppedSandboxSummary[]> {
  const apiKey = resolveDaytonaKey(apiKeyOverride);
  const base = daytonaApiBase();
  const out: DaytonaStoppedSandboxSummary[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100 && out.length < maxItems; guard++) {
    const url = new URL(`${base}/sandbox`);
    url.searchParams.set('limit', '200');
    url.searchParams.set('states', 'stopped');
    url.searchParams.set('sort', 'lastActivityAt');
    url.searchParams.set('order', 'asc');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DAYTONA_REST_CALL_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Daytona list sandboxes failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      items?: Array<{ id: string; disk?: number; lastActivityAt?: string; labels?: Record<string, string> }>;
      nextCursor?: string | null;
    };
    const items = body.items ?? [];
    for (const it of items) {
      out.push({
        id: it.id,
        disk: it.disk ?? 0,
        lastActivityAt: it.lastActivityAt ?? null,
        managed: Boolean(it.labels?.['kortix.managed']),
      });
      if (out.length >= maxItems) break;
    }
    cursor = body.nextCursor ?? null;
    if (!cursor || items.length === 0) break;
  }
  return out;
}

/**
 * Archive a sandbox by id (stopped → cold storage, still resumable — never
 * destructive). Returns true on success or when the sandbox is already
 * gone/archiving/archived (404/409); false on any other failure — including
 * "cannot be archived for this region/class" (some legacy sandboxClasses),
 * which the caller should just skip rather than treat as fatal. Best-effort —
 * never throws so a batch sweep continues past a single bad row.
 */
export async function archiveDaytonaSandboxById(id: string, apiKeyOverride?: string): Promise<boolean> {
  const apiKey = resolveOptionalDaytonaKey(apiKeyOverride);
  if (!apiKey) return false;
  try {
    const res = await fetch(`${daytonaApiBase()}/sandbox/${id}/archive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DAYTONA_REST_CALL_TIMEOUT_MS),
    });
    return res.ok || res.status === 404 || res.status === 409;
  } catch {
    return false;
  }
}

export interface DaytonaOrgLimits {
  orgId: string;
  totalCpuQuota: number;
  totalMemoryQuotaGb: number;
  totalDiskQuotaGb: number;
  maxRunningSandboxes: number;
  maxNonArchivedSandboxes: number;
  source: 'api' | 'fallback';
  fetchedAtMs: number;
}

const ORG_LIMITS_CACHE_TTL_MS = 10 * 60_000;
const ORG_LIMITS_FALLBACK_TTL_MS = 60_000;
const LEARNED_CAP_TTL_MS = 30 * 60_000;
// replica-local: 10-minute per-org Daytona usage/quota cache; safe to recompute per replica.
const orgLimitsCache = new Map<string, { value: DaytonaOrgLimits; expiresAt: number }>();
// replica-local: short-lived learned downward cap overrides after Daytona rejects with quota errors.
const learnedOrgCapCache = new Map<
  string,
  { maxRunning?: number; maxNonArchived?: number; expiresAt: number }
>();

export function resetDaytonaOrgLimitsCache(): void {
  orgLimitsCache.clear();
  learnedOrgCapCache.clear();
}

export function getLearnedDaytonaOrgCap(
  orgId: string,
): { maxRunning?: number; maxNonArchived?: number } | null {
  const entry = learnedOrgCapCache.get(orgId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    learnedOrgCapCache.delete(orgId);
    return null;
  }
  return { maxRunning: entry.maxRunning, maxNonArchived: entry.maxNonArchived };
}

/**
 * Record a learned lower cap for `orgId` after Daytona rejects a create/start
 * with a compute or disk quota error despite our estimated capacity. Bounded
 * `>= 1` so an org is never locked to 0.
 */
export function recordLearnedDaytonaOrgCap(
  orgId: string,
  kind: 'running' | 'disk',
  observedCap: number,
): { maxRunning?: number; maxNonArchived?: number } {
  const bounded = Math.max(1, Math.floor(observedCap));
  const current = getLearnedDaytonaOrgCap(orgId) ?? {};
  const next = {
    maxRunning:
      kind === 'running'
        ? Math.min(current.maxRunning ?? bounded, bounded)
        : current.maxRunning,
    maxNonArchived:
      kind === 'disk'
        ? Math.min(current.maxNonArchived ?? bounded, bounded)
        : current.maxNonArchived,
    expiresAt: Date.now() + LEARNED_CAP_TTL_MS,
  };
  learnedOrgCapCache.set(orgId, next);
  return { maxRunning: next.maxRunning, maxNonArchived: next.maxNonArchived };
}

/**
 * Read live per-org quotas from `GET /organizations/:orgId/usage` (verified
 * HTTP 200 on Daytona Cloud) and compute how many Kortix sandboxes fit inside
 * the org's CPU, memory, and active-disk limits. Caches per org for 10 min;
 * falls back to conservative Tier-1 defaults (2 running / 3 non-archived) if
 * Daytona does not return quota fields.
 */
export async function fetchDaytonaOrgLimits(
  apiKey: string,
  orgId: string,
  opts: {
    region?: string;
    sandboxCpu?: number;
    sandboxMemoryGb?: number;
    sandboxDiskGb?: number;
    forceRefresh?: boolean;
  } = {},
): Promise<DaytonaOrgLimits> {
  const nowMs = Date.now();
  const cacheKey = `${orgId}:${opts.region || 'default'}`;
  const cached = !opts.forceRefresh ? orgLimitsCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > nowMs) {
    return cached.value;
  }

  const sandboxCpu = Math.max(1, opts.sandboxCpu ?? 2);
  const sandboxMemoryGb = Math.max(1, opts.sandboxMemoryGb ?? 4);
  const sandboxDiskGb = Math.max(1, opts.sandboxDiskGb ?? 10);

  const fallback = (): DaytonaOrgLimits => {
    const val: DaytonaOrgLimits = {
      orgId,
      totalCpuQuota: 10,
      totalMemoryQuotaGb: 10,
      totalDiskQuotaGb: 30,
      maxRunningSandboxes: Math.max(
        1,
        Math.floor(Math.min(10 / sandboxMemoryGb, 10 / sandboxCpu)),
      ),
      maxNonArchivedSandboxes: Math.max(1, Math.floor(30 / sandboxDiskGb)),
      source: 'fallback',
      fetchedAtMs: nowMs,
    };
    orgLimitsCache.set(cacheKey, { value: val, expiresAt: nowMs + ORG_LIMITS_FALLBACK_TTL_MS });
    return val;
  };

  if (!apiKey || !orgId) return fallback();

  try {
    const res = await fetch(`${daytonaApiBase()}/organizations/${encodeURIComponent(orgId)}/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DAYTONA_REST_CALL_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      const err = new Error(`Daytona organization usage unauthorized: HTTP ${res.status}`) as Error & {
        status?: number;
      };
      err.status = res.status;
      throw err;
    }
    if (!res.ok) return fallback();
    type QuotaFields = {
      regionId?: string;
      sandboxClass?: string;
      totalCpuQuota?: number;
      totalMemoryQuota?: number;
      totalDiskQuota?: number;
    };
    const body = (await res.json()) as QuotaFields & {
      limits?: QuotaFields;
      regionUsage?: QuotaFields[];
    };
    const regions = Array.isArray(body.regionUsage) ? body.regionUsage : [];
    const desiredRegion = (opts.region || '').trim().toLowerCase();
    const regionEntry =
      (desiredRegion
        ? regions.find(
            (r) =>
              String(r.regionId ?? '').toLowerCase() === desiredRegion &&
              String(r.sandboxClass ?? '').toLowerCase() === 'container',
          ) ??
          regions.find((r) => String(r.regionId ?? '').toLowerCase() === desiredRegion)
        : undefined) ??
      regions.find((r) => String(r.sandboxClass ?? '').toLowerCase() === 'container') ??
      regions[0];
    const totalCpuQuota = Number(
      regionEntry?.totalCpuQuota ?? body.totalCpuQuota ?? body.limits?.totalCpuQuota ?? 0,
    );
    const totalMemoryQuotaGb = Number(
      regionEntry?.totalMemoryQuota ?? body.totalMemoryQuota ?? body.limits?.totalMemoryQuota ?? 0,
    );
    const totalDiskQuotaGb = Number(
      regionEntry?.totalDiskQuota ?? body.totalDiskQuota ?? body.limits?.totalDiskQuota ?? 0,
    );
    if (
      !Number.isFinite(totalCpuQuota) ||
      totalCpuQuota <= 0 ||
      !Number.isFinite(totalMemoryQuotaGb) ||
      totalMemoryQuotaGb <= 0 ||
      !Number.isFinite(totalDiskQuotaGb) ||
      totalDiskQuotaGb <= 0
    ) {
      return fallback();
    }
    const maxRunningSandboxes = Math.max(
      1,
      Math.floor(Math.min(totalMemoryQuotaGb / sandboxMemoryGb, totalCpuQuota / sandboxCpu)),
    );
    const maxNonArchivedSandboxes = Math.max(1, Math.floor(totalDiskQuotaGb / sandboxDiskGb));
    const value: DaytonaOrgLimits = {
      orgId,
      totalCpuQuota,
      totalMemoryQuotaGb,
      totalDiskQuotaGb,
      maxRunningSandboxes,
      maxNonArchivedSandboxes,
      source: 'api',
      fetchedAtMs: nowMs,
    };
    orgLimitsCache.set(cacheKey, { value, expiresAt: nowMs + ORG_LIMITS_CACHE_TTL_MS });
    return value;
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) throw err;
    return fallback();
  }
}
