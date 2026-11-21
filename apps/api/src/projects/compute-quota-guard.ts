/**
 * Reactive and proactive Daytona capacity & LRU concurrency slot manager.
 *
 * Keeps Kortix within Tier-1 Daytona quotas (10 GiB RAM / 30 GiB active disk):
 *  - Only touches Kortix-managed sandboxes (`sb.managed === true`), never unrelated projects.
 *  - Proactive LRU guard (`ensureDaytonaCapacitySlot`): before creating/waking a
 *    sandbox, gracefully stops excess idle running sandboxes above `maxRunning - 1`
 *    and archives excess stopped sandboxes above `maxNonArchived - 1`.
 *  - Reactive compute eviction (`evictIdleRunningDaytonaSandboxes`): frees RAM/CPU
 *    slots when Daytona rejects with `Total memory/CPU limit exceeded`.
 *  - Reactive disk reclaim (`reclaimDaytonaDiskSlots`): archives stopped Kortix
 *    sandboxes (or stops + archives LRU idle running box if none stopped) and waits
 *    for Daytona to confirm `archived` before retrying on `Total disk limit exceeded`.
 */

import { inArray } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db, hasDatabase } from '../shared/db';
import type {
  DaytonaStartedSandboxSummary,
  DaytonaStoppedSandboxSummary,
} from '../shared/daytona';

const ACTIVE_TURN_FRESHNESS_MS = 10 * 60_000;
const STATE_WAIT_TIMEOUT_MS = 15_000;
const STATE_WAIT_POLL_MS = 500;
const MAX_EVICT_PER_PASS = 2;

export interface ComputeQuotaEvictionResult {
  runningCount: number;
  evictedIds: string[];
  freedMemoryGb: number;
}

export interface DiskSlotReclaimResult {
  stoppedCount: number;
  archivedIds: string[];
  freedDiskGb: number;
}

export interface ComputeQuotaGuardDeps {
  listStarted: (maxItems: number) => Promise<DaytonaStartedSandboxSummary[]>;
  stop: (id: string) => Promise<boolean>;
  getState: (id: string) => Promise<string | null>;
}

export interface DaytonaSlotManagerDeps extends ComputeQuotaGuardDeps {
  listStopped: (maxItems: number) => Promise<DaytonaStoppedSandboxSummary[]>;
  archive: (id: string) => Promise<boolean>;
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
      if (row.updatedAt && nowMs - row.updatedAt.getTime() < ACTIVE_TURN_FRESHNESS_MS) return true;
      continue;
    }
    if (nowMs - startedAtMs < ACTIVE_TURN_FRESHNESS_MS) return true;
  }
  return false;
}

async function waitUntilState(
  id: string,
  getState: (id: string) => Promise<string | null>,
  targets: readonly string[],
): Promise<void> {
  const deadline = Date.now() + STATE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await getState(id);
    if (!state || targets.includes(state)) return;
    await new Promise((r) => setTimeout(r, STATE_WAIT_POLL_MS));
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
      '[daytona-slot-manager] failed to mark evicted sandboxes stopped in DB:',
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
      '[daytona-slot-manager] failed to query session_sandboxes activity:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return map;
}

async function stopSandboxesLru(
  candidates: DaytonaStartedSandboxSummary[],
  count: number,
  reason: string,
  deps: Pick<ComputeQuotaGuardDeps, 'stop' | 'getState'>,
): Promise<{ evictedIds: string[]; freedMemoryGb: number }> {
  if (count <= 0 || candidates.length === 0) {
    return { evictedIds: [], freedMemoryGb: 0 };
  }
  const nowMs = Date.now();
  const dbRows = await loadSandboxRows(candidates.map((sb) => sb.id));
  const idle = candidates.filter((sb) => !hasFreshActiveTurn(dbRows.get(sb.id), nowMs));
  const busy = candidates.filter((sb) => hasFreshActiveTurn(dbRows.get(sb.id), nowMs));
  const ordered = [...idle, ...busy].slice(0, count);

  const evictedIds: string[] = [];
  let freedMemoryGb = 0;
  for (const target of ordered) {
    console.warn(
      `[daytona-slot-manager] stopping LRU Kortix sandbox ${target.id} (${reason}, ` +
        `mem=${target.memory}GiB, lastActivityAt=${target.lastActivityAt ?? 'unknown'})`,
    );
    const stopped = await deps.stop(target.id);
    if (stopped) {
      await waitUntilState(target.id, deps.getState, ['stopped', 'archived', 'destroyed']);
      evictedIds.push(target.id);
      freedMemoryGb += target.memory || 4;
    }
  }
  if (evictedIds.length > 0) {
    await markStoppedInDb(evictedIds);
  }
  return { evictedIds, freedMemoryGb };
}

async function archiveSandboxesLru(
  candidates: DaytonaStoppedSandboxSummary[],
  count: number,
  reason: string,
  deps: Pick<DaytonaSlotManagerDeps, 'archive' | 'getState'>,
): Promise<{ archivedIds: string[]; freedDiskGb: number }> {
  if (count <= 0 || candidates.length === 0) {
    return { archivedIds: [], freedDiskGb: 0 };
  }
  const targets = candidates.slice(0, count);
  const archivedIds: string[] = [];
  let freedDiskGb = 0;
  for (const target of targets) {
    console.warn(
      `[daytona-slot-manager] archiving stopped Kortix sandbox ${target.id} (${reason}, ` +
        `disk=${target.disk}GiB, lastActivityAt=${target.lastActivityAt ?? 'unknown'})`,
    );
    const ok = await deps.archive(target.id);
    if (ok) {
      await waitUntilState(target.id, deps.getState, ['archived', 'destroyed']);
      archivedIds.push(target.id);
      freedDiskGb += target.disk || 10;
    }
  }
  if (archivedIds.length > 0) {
    await markStoppedInDb(archivedIds);
  }
  return { archivedIds, freedDiskGb };
}

// Partition single-flight locks strictly per Daytona organization (`partitionKey` = daytonaOrgId)
// so User A's eviction/reclaim/capacity guard never blocks or evicts User B.
const inFlightComputeByOrg = new Map<string, Promise<ComputeQuotaEvictionResult>>();
const inFlightDiskByOrg = new Map<string, Promise<DiskSlotReclaimResult>>();
const inFlightCapacityByOrg = new Map<string, Promise<void>>();

/**
 * Single-flight reactive eviction: stops the oldest idle running Kortix
 * sandbox(es) (excluding `excludeExternalId`) and waits for RAM release.
 */
export function evictIdleRunningDaytonaSandboxes(
  reason: string,
  deps: ComputeQuotaGuardDeps,
  excludeExternalId?: string,
  partitionKey = 'default',
): Promise<ComputeQuotaEvictionResult> {
  const existing = inFlightComputeByOrg.get(partitionKey);
  if (existing) return existing;

  const run = (async (): Promise<ComputeQuotaEvictionResult> => {
    const startedAll = await deps.listStarted(50);
    const eligible = startedAll.filter((sb) => sb.managed && sb.id !== excludeExternalId);
    if (eligible.length === 0) {
      console.warn(
        `[daytona-slot-manager:${partitionKey}] compute quota hit (${reason}) — 0 eligible started Kortix sandboxes to evict`,
      );
      return { runningCount: startedAll.length, evictedIds: [], freedMemoryGb: 0 };
    }
    const { evictedIds, freedMemoryGb } = await stopSandboxesLru(
      eligible,
      MAX_EVICT_PER_PASS,
      `compute-quota:${partitionKey}:${reason}`,
      deps,
    );
    return { runningCount: startedAll.length, evictedIds, freedMemoryGb };
  })().finally(() => {
    inFlightComputeByOrg.delete(partitionKey);
  });

  inFlightComputeByOrg.set(partitionKey, run);
  return run;
}

/**
 * Single-flight reactive disk reclaim: archives stopped Kortix sandboxes
 * (and waits until Daytona confirms `archived`) so active storage drops before
 * retrying create/start. If no stopped Kortix box exists, stops and archives
 * the oldest idle running Kortix box.
 */
export function reclaimDaytonaDiskSlots(
  reason: string,
  deps: DaytonaSlotManagerDeps,
  excludeExternalId?: string,
  maxToArchive = MAX_EVICT_PER_PASS,
  partitionKey = 'default',
): Promise<DiskSlotReclaimResult> {
  const existing = inFlightDiskByOrg.get(partitionKey);
  if (existing) return existing;

  const run = (async (): Promise<DiskSlotReclaimResult> => {
    const stoppedAll = await deps.listStopped(50);
    const stoppedKortix = stoppedAll.filter(
      (sb) => sb.managed !== false && sb.id !== excludeExternalId,
    );
    if (stoppedKortix.length > 0) {
      const { archivedIds, freedDiskGb } = await archiveSandboxesLru(
        stoppedKortix,
        maxToArchive,
        `disk-quota:${partitionKey}:${reason}`,
        deps,
      );
      return { stoppedCount: stoppedAll.length, archivedIds, freedDiskGb };
    }

    // No stopped Kortix boxes left to archive: stop + archive the oldest idle running Kortix box.
    const startedAll = await deps.listStarted(50);
    const runningKortix = startedAll.filter((sb) => sb.managed && sb.id !== excludeExternalId);
    if (runningKortix.length === 0) {
      console.warn(
        `[daytona-slot-manager:${partitionKey}] disk quota hit (${reason}) — 0 Kortix sandboxes available to archive`,
      );
      return { stoppedCount: 0, archivedIds: [], freedDiskGb: 0 };
    }
    const stoppedRes = await stopSandboxesLru(
      runningKortix,
      1,
      `disk-quota-stop:${partitionKey}:${reason}`,
      deps,
    );
    if (stoppedRes.evictedIds.length === 0) {
      return { stoppedCount: 0, archivedIds: [], freedDiskGb: 0 };
    }
    const { archivedIds, freedDiskGb } = await archiveSandboxesLru(
      stoppedRes.evictedIds.map((id) => ({ id, disk: 10, lastActivityAt: null, managed: true })),
      1,
      `disk-quota-archive:${partitionKey}:${reason}`,
      deps,
    );
    return { stoppedCount: stoppedRes.evictedIds.length, archivedIds, freedDiskGb };
  })().finally(() => {
    inFlightDiskByOrg.delete(partitionKey);
  });

  inFlightDiskByOrg.set(partitionKey, run);
  return run;
}

/**
 * Proactive LRU slot manager called before creating or waking a sandbox:
 * keeps running Kortix boxes strictly < `maxRunning` (stopping LRU idle first)
 * and keeps non-archived Kortix boxes (running + stopped) strictly < `maxNonArchived`
 * (archiving LRU stopped first) so switching across 2-3+ chats never hits quota.
 */
export function ensureDaytonaCapacitySlot(
  reason: string,
  deps: DaytonaSlotManagerDeps,
  limits: { maxRunning: number; maxNonArchived: number },
  excludeExternalId?: string,
  partitionKey = 'default',
): Promise<void> {
  const existing = inFlightCapacityByOrg.get(partitionKey);
  if (existing) return existing;

  const run = (async (): Promise<void> => {
    const [startedAll, stoppedAll] = await Promise.all([
      deps.listStarted(50),
      deps.listStopped(50),
    ]);
    const startedKortix = startedAll.filter((sb) => sb.managed && sb.id !== excludeExternalId);
    const stoppedKortix = stoppedAll.filter(
      (sb) => sb.managed !== false && sb.id !== excludeExternalId,
    );

    const maxRunningOthers = Math.max(0, limits.maxRunning - 1);
    const needStop = Math.max(0, startedKortix.length - maxRunningOthers);
    const newlyStoppedIds: string[] = [];
    if (needStop > 0) {
      const stopRes = await stopSandboxesLru(
        startedKortix,
        needStop,
        `lru-concurrency:${partitionKey}:${reason}`,
        deps,
      );
      newlyStoppedIds.push(...stopRes.evictedIds);
    }

    const totalOtherNonArchived = startedKortix.length + stoppedKortix.length;
    const maxOtherNonArchived = Math.max(0, limits.maxNonArchived - 1);
    const needArchive = Math.max(0, totalOtherNonArchived - maxOtherNonArchived);
    if (needArchive > 0) {
      const archivePool: DaytonaStoppedSandboxSummary[] = [
        ...stoppedKortix,
        ...newlyStoppedIds.map((id) => ({ id, disk: 10, lastActivityAt: null, managed: true })),
      ];
      await archiveSandboxesLru(
        archivePool,
        needArchive,
        `lru-disk:${partitionKey}:${reason}`,
        deps,
      );
    }
  })().finally(() => {
    inFlightCapacityByOrg.delete(partitionKey);
  });

  inFlightCapacityByOrg.set(partitionKey, run);
  return run;
}
