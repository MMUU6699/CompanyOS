/**
 * Reactive Daytona compute-quota guard (RAM / CPU / concurrency limits).
 *
 * When a Daytona org has a tight concurrent memory cap (e.g. 10 GiB = max 2
 * running 4 GiB sandboxes), opening a 3rd session or waking a stopped session
 * fails immediately with `Total memory limit exceeded. Maximum allowed: 10GiB.`
 *
 * When that error occurs on create() or start(), this guard lists currently
 * STARTED Daytona sandboxes (oldest activity first), checks `session_sandboxes`
 * for active turns, stops the oldest idle running box(es), waits until Daytona
 * releases the RAM slot, marks their DB rows `stopped`, and lets the caller
 * retry seamlessly.
 */

import { inArray, eq } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db, hasDatabase } from '../shared/db';
import type { DaytonaStartedSandboxSummary } from '../shared/daytona';

const ACTIVE_TURN_FRESHNESS_MS = 10 * 60_000;
const STOP_WAIT_TIMEOUT_MS = 12_000;
const STOP_WAIT_POLL_MS = 500;
const MAX_EVICT_PER_PASS = 2;

export interface ComputeQuotaEvictionResult {
  runningCount: number;
  evictedIds: string[];
  freedMemoryGb: number;
}

export interface ComputeQuotaGuardDeps {
  listStarted: (maxItems: number) => Promise<DaytonaStartedSandboxSummary[]>;
  stop: (id: string) => Promise<boolean>;
  getState: (id: string) => Promise<string | null>;
}

interface SandboxActivityRow {
  externalId: string | null;
  updatedAt: Date | null;
  metadata: Record<string, unknown> | null;
}

function hasFreshActiveTurn(row: SandboxActivityRow | undefined, nowMs: number): boolean {
  if (!row?.metadata) return false;
  const activeTurns = row.metadata.activeTurns;
  if (!activeTurns || typeof activeTurns !== 'object' || Array.isArray(activeTurns)) {
    return false;
  }
  const entries = Object.values(activeTurns as Record<string, unknown>);
  if (entries.length === 0) return false;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const startedAtMs = Number((entry as { startedAtMs?: unknown }).startedAtMs ?? 0);
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) {
      // Unknown timestamp: trust updated_at recency.
      if (row.updatedAt && nowMs - row.updatedAt.getTime() < ACTIVE_TURN_FRESHNESS_MS) return true;
      continue;
    }
    if (nowMs - startedAtMs < ACTIVE_TURN_FRESHNESS_MS) return true;
  }
  return false;
}

async function waitUntilStopped(
  id: string,
  getState: (id: string) => Promise<string | null>,
): Promise<void> {
  const deadline = Date.now() + STOP_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await getState(id);
    if (!state || state === 'stopped' || state === 'archived' || state === 'destroyed') {
      return;
    }
    await new Promise((r) => setTimeout(r, STOP_WAIT_POLL_MS));
  }
}

async function markStoppedInDb(externalIds: string[]): Promise<void> {
  if (!hasDatabase || externalIds.length === 0) return;
  try {
    await db
      .update(sessionSandboxes)
      .set({ status: 'stopped', updatedAt: new Date() })
      .where(inArray(sessionSandboxes.externalId, externalIds));
  } catch (err) {
    console.warn(
      '[daytona-compute-quota] failed to mark evicted sandboxes stopped in DB:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function loadSandboxRows(externalIds: string[]): Promise<Map<string, SandboxActivityRow>> {
  const map = new Map<string, SandboxActivityRow>();
  if (!hasDatabase || externalIds.length === 0) return map;
  try {
    const rows = await db
      .select({
        externalId: sessionSandboxes.externalId,
        updatedAt: sessionSandboxes.updatedAt,
        metadata: sessionSandboxes.metadata,
      })
      .from(sessionSandboxes)
      .where(inArray(sessionSandboxes.externalId, externalIds));
    for (const row of rows) {
      if (row.externalId) {
        map.set(row.externalId, {
          externalId: row.externalId,
          updatedAt: row.updatedAt,
          metadata: (row.metadata as Record<string, unknown> | null) ?? null,
        });
      }
    }
  } catch (err) {
    console.warn(
      '[daytona-compute-quota] failed to query session_sandboxes activity:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return map;
}

let inFlight: Promise<ComputeQuotaEvictionResult> | null = null;

/**
 * Single-flight eviction pass: stops the oldest idle running Daytona sandbox(es)
 * (excluding `excludeExternalId`) and waits for Daytona to release their RAM.
 */
export function evictIdleRunningDaytonaSandboxes(
  reason: string,
  deps: ComputeQuotaGuardDeps,
  excludeExternalId?: string,
): Promise<ComputeQuotaEvictionResult> {
  if (inFlight) return inFlight;

  const run = (async (): Promise<ComputeQuotaEvictionResult> => {
    const started = await deps.listStarted(50);
    const eligible = started.filter((sb) => sb.id !== excludeExternalId);
    if (eligible.length === 0) {
      console.warn(
        `[daytona-compute-quota] quota hit (${reason}) but 0 other started sandboxes found to evict`,
      );
      return { runningCount: started.length, evictedIds: [], freedMemoryGb: 0 };
    }

    const nowMs = Date.now();
    const dbRows = await loadSandboxRows(eligible.map((sb) => sb.id));

    // Prefer idle or orphaned boxes (no fresh active turn).
    const idle = eligible.filter((sb) => !hasFreshActiveTurn(dbRows.get(sb.id), nowMs));
    // If every running box appears busy and >= 2 boxes are holding the org cap,
    // still evict the single oldest box so new sessions are never permanently wedged.
    const targets =
      idle.length > 0
        ? idle.slice(0, MAX_EVICT_PER_PASS)
        : eligible.slice(0, 1);

    const evictedIds: string[] = [];
    let freedMemoryGb = 0;

    for (const target of targets) {
      console.warn(
        `[daytona-compute-quota] quota hit (${reason}) — stopping idle sandbox ${target.id} ` +
          `(memory=${target.memory}GiB lastActivityAt=${target.lastActivityAt ?? 'unknown'})`,
      );
      const stopped = await deps.stop(target.id);
      if (stopped) {
        await waitUntilStopped(target.id, deps.getState);
        evictedIds.push(target.id);
        freedMemoryGb += target.memory || 4;
      }
    }

    if (evictedIds.length > 0) {
      await markStoppedInDb(evictedIds);
      console.warn(
        `[daytona-compute-quota] eviction complete (${reason}): stopped=${evictedIds.length} ` +
          `freed~${freedMemoryGb}GiB ids=[${evictedIds.join(',')}]`,
      );
    }

    return { runningCount: started.length, evictedIds, freedMemoryGb };
  })().finally(() => {
    inFlight = null;
  });

  inFlight = run;
  return run;
}

// Keep unused import guard clean if eq is removed later
void eq;
