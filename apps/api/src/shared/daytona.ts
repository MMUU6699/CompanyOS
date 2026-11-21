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
  const key = apiKeyOverride?.trim() || config.DAYTONA_API_KEY;
  if (!key) throw new Error('Missing DAYTONA_API_KEY');
  return key;
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
  const apiKey = apiKeyOverride?.trim() || config.DAYTONA_API_KEY;
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
  const apiKey = apiKeyOverride?.trim() || config.DAYTONA_API_KEY;
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
  const apiKey = apiKeyOverride?.trim() || config.DAYTONA_API_KEY;
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
  const apiKey = apiKeyOverride?.trim() || config.DAYTONA_API_KEY;
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
