/**
 * Reactive and proactive Daytona capacity & LRU concurrency slot manager.
 *
 * Keeps Kortix within per-org Daytona quotas (dynamically read from
 * `GET /organizations/:orgId/usage` or learned caps; fallback Tier-1:
 * 10 GiB RAM / 30 GiB active disk):
 *  - Only touches Kortix-managed sandboxes (`sb.managed === true`), never unrelated projects.
 *  - NEVER stops a sandbox with an active turn (`hasFreshActiveTurn`). If all
 *    running sandboxes are busy and a slot cannot be freed, throws typed
 *    `DaytonaAllSandboxesBusyError` (`DAYTONA_QUOTA_EXCEEDED`, retriable: true)
 *    so the caller queues cleanly instead of killing live agent work.
 *  - Concurrent capacity passes for the same org serialize via promise chaining
 *    while registering EVERY concurrent caller's `excludeExternalId` in a
 *    ref-counted protection map so joiners never have their own sandbox evicted
 *    and every open gets its own slot guarantee.
 */

import { inArray } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db, hasDatabase } from '../shared/db';
import { logger } from '../lib/logger';
import { DaytonaAllSandboxesBusyError } from '../shared/daytona-errors';
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
  busyCount?: number;
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
  /** Optional override for active-turn detection (defaults to DB `session_sandboxes.metadata.activeTurns`). */
  isBusy?: (externalId: string) => Promise<boolean> | boolean;
  /** Optional sleep override for fast unit tests. */
  sleep?: (ms: number) => Promise<void>;
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
  sleepFn?: (ms: number) => Promise<void>,
): Promise<void> {
  const sleep = sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + STATE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await getState(id);
    if (!state || targets.includes(state)) return;
    await sleep(STATE_WAIT_POLL_MS);
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
    logger.warn('[daytona-slot-manager] failed to mark evicted sandboxes stopped in DB', {
      error: err instanceof Error ? err.message : String(err),
    });
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
    logger.warn('[daytona-slot-manager] failed to query session_sandboxes activity', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return map;
}

async function partitionIdleAndBusy(
  candidates: DaytonaStartedSandboxSummary[],
  isBusyOverride?: (externalId: string) => Promise<boolean> | boolean,
): Promise<{ idle: DaytonaStartedSandboxSummary[]; busy: DaytonaStartedSandboxSummary[] }> {
  if (candidates.length === 0) return { idle: [], busy: [] };
  if (isBusyOverride) {
    const idle: DaytonaStartedSandboxSummary[] = [];
    const busy: DaytonaStartedSandboxSummary[] = [];
    for (const sb of candidates) {
      const active = await isBusyOverride(sb.id);
      if (active) busy.push(sb);
      else idle.push(sb);
    }
    return { idle, busy };
  }
  const nowMs = Date.now();
  const dbRows = await loadSandboxRows(candidates.map((sb) => sb.id));
  const idle: DaytonaStartedSandboxSummary[] = [];
  const busy: DaytonaStartedSandboxSummary[] = [];
  for (const sb of candidates) {
    if (hasFreshActiveTurn(dbRows.get(sb.id), nowMs)) busy.push(sb);
    else idle.push(sb);
  }
  return { idle, busy };
}

/**
 * Stop up to `count` IDLE LRU sandboxes. NEVER stops a sandbox with an active
 * turn — callers receive `busyCount` and must queue / throw
 * `DaytonaAllSandboxesBusyError` when not enough idle sandboxes exist.
 */
async function stopSandboxesLru(
  candidates: DaytonaStartedSandboxSummary[],
  count: number,
  reason: string,
  deps: Pick<ComputeQuotaGuardDeps, 'stop' | 'getState' | 'isBusy' | 'sleep'>,
): Promise<{ evictedIds: string[]; freedMemoryGb: number; busyCount: number }> {
  if (count <= 0 || candidates.length === 0) {
    return { evictedIds: [], freedMemoryGb: 0, busyCount: 0 };
  }
  const { idle, busy } = await partitionIdleAndBusy(candidates, deps.isBusy);
  const ordered = idle.slice(0, count);

  const evictedIds: string[] = [];
  let freedMemoryGb = 0;
  for (const target of ordered) {
    logger.warn('[daytona-slot-manager] stopping idle LRU Kortix sandbox', {
      externalId: target.id,
      reason,
      memoryGiB: target.memory,
      lastActivityAt: target.lastActivityAt ?? 'unknown',
    });
    const stopped = await deps.stop(target.id);
    if (stopped) {
      await waitUntilState(target.id, deps.getState, ['stopped', 'archived', 'destroyed'], deps.sleep);
      evictedIds.push(target.id);
      freedMemoryGb += target.memory || 4;
    }
  }
  if (evictedIds.length > 0) {
    await markStoppedInDb(evictedIds);
  }
  return { evictedIds, freedMemoryGb, busyCount: busy.length };
}

async function archiveSandboxesLru(
  candidates: DaytonaStoppedSandboxSummary[],
  count: number,
  reason: string,
  deps: Pick<DaytonaSlotManagerDeps, 'archive' | 'getState' | 'sleep'>,
): Promise<{ archivedIds: string[]; freedDiskGb: number }> {
  if (count <= 0 || candidates.length === 0) {
    return { archivedIds: [], freedDiskGb: 0 };
  }
  const targets = candidates.slice(0, count);
  const archivedIds: string[] = [];
  let freedDiskGb = 0;
  for (const target of targets) {
    logger.warn('[daytona-slot-manager] archiving stopped Kortix sandbox', {
      externalId: target.id,
      reason,
      diskGiB: target.disk,
      lastActivityAt: target.lastActivityAt ?? 'unknown',
    });
    const ok = await deps.archive(target.id);
    if (ok) {
      await waitUntilState(target.id, deps.getState, ['archived', 'destroyed'], deps.sleep);
      archivedIds.push(target.id);
      freedDiskGb += target.disk || 10;
    }
  }
  if (archivedIds.length > 0) {
    await markStoppedInDb(archivedIds);
  }
  return { archivedIds, freedDiskGb };
}

// replica-local: per-org serialization tails so concurrent opens/evictions for
// the same Daytona org run in order and every joiner re-checks live state.
const capacityTailByOrg = new Map<string, Promise<void>>();
// replica-local: per-org reactive compute-eviction tail; serializes passes so
// joiners never lose their `excludeExternalId`.
const computeTailByOrg = new Map<string, Promise<void>>();
// replica-local: per-org reactive disk-reclaim tail; serializes passes so
// joiners never lose their `excludeExternalId`.
const diskTailByOrg = new Map<string, Promise<void>>();
// replica-local: ref-counted `excludeExternalId` protection set per Daytona org
// so a concurrent joiner's sandbox is NEVER evicted by an earlier in-flight pass.
const protectedExternalIdsByOrg = new Map<string, Map<string, number>>();

function addProtectedExternalId(partitionKey: string, externalId: string | undefined): void {
  if (!externalId) return;
  let counts = protectedExternalIdsByOrg.get(partitionKey);
  if (!counts) {
    counts = new Map<string, number>();
    protectedExternalIdsByOrg.set(partitionKey, counts);
  }
  counts.set(externalId, (counts.get(externalId) ?? 0) + 1);
}

function removeProtectedExternalId(partitionKey: string, externalId: string | undefined): void {
  if (!externalId) return;
  const counts = protectedExternalIdsByOrg.get(partitionKey);
  if (!counts) return;
  const next = (counts.get(externalId) ?? 1) - 1;
  if (next <= 0) counts.delete(externalId);
  else counts.set(externalId, next);
  if (counts.size === 0) protectedExternalIdsByOrg.delete(partitionKey);
}

function isProtectedExternalId(partitionKey: string, externalId: string): boolean {
  const counts = protectedExternalIdsByOrg.get(partitionKey);
  return Boolean(counts && (counts.get(externalId) ?? 0) > 0);
}

function enqueueOrgPass<T>(
  tailMap: Map<string, Promise<void>>,
  partitionKey: string,
  excludeExternalId: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  // Register protection IMMEDIATELY (before awaiting prior queued passes) so
  // an already-running pass in this org cannot evict this joiner's sandbox.
  addProtectedExternalId(partitionKey, excludeExternalId);
  const prev = tailMap.get(partitionKey) ?? Promise.resolve();
  let resultPromise: Promise<T>;
  const tailPromise = new Promise<void>((resolveTail) => {
    resultPromise = prev
      .catch(() => undefined)
      .then(() => work())
      .finally(() => {
        removeProtectedExternalId(partitionKey, excludeExternalId);
        resolveTail();
      });
  });
  const trackedTail = tailPromise.finally(() => {
    if (tailMap.get(partitionKey) === trackedTail) {
      tailMap.delete(partitionKey);
    }
  });
  tailMap.set(partitionKey, trackedTail);
  return resultPromise!;
}

/**
 * Serialized reactive eviction: stops the oldest idle running Kortix
 * sandbox(es) (excluding all protected `excludeExternalId`s) and waits for RAM
 * release. Never stops sandboxes with active turns; throws
 * `DaytonaAllSandboxesBusyError` if every eligible box is busy.
 */
export function evictIdleRunningDaytonaSandboxes(
  reason: string,
  deps: ComputeQuotaGuardDeps,
  excludeExternalId?: string,
  partitionKey = 'default',
): Promise<ComputeQuotaEvictionResult> {
  return enqueueOrgPass(computeTailByOrg, partitionKey, excludeExternalId, async () => {
    const startedAll = await deps.listStarted(50);
    const eligible = startedAll.filter(
      (sb) => sb.managed && sb.id !== excludeExternalId && !isProtectedExternalId(partitionKey, sb.id),
    );
    if (eligible.length === 0) {
      logger.warn('[daytona-slot-manager] compute quota hit with 0 eligible started sandboxes', {
        partitionKey,
        reason,
        runningCount: startedAll.length,
      });
      return { runningCount: startedAll.length, evictedIds: [], freedMemoryGb: 0, busyCount: 0 };
    }
    const { evictedIds, freedMemoryGb, busyCount } = await stopSandboxesLru(
      eligible,
      MAX_EVICT_PER_PASS,
      `compute-quota:${partitionKey}:${reason}`,
      deps,
    );
    if (evictedIds.length === 0 && busyCount > 0) {
      throw new DaytonaAllSandboxesBusyError();
    }
    return { runningCount: startedAll.length, evictedIds, freedMemoryGb, busyCount };
  });
}

/**
 * Serialized reactive disk reclaim: archives stopped Kortix sandboxes
 * (and waits until Daytona confirms `archived`) so active storage drops before
 * retrying create/start. If no stopped Kortix box exists, stops and archives
 * the oldest IDLE running Kortix box (never a busy one).
 */
export function reclaimDaytonaDiskSlots(
  reason: string,
  deps: DaytonaSlotManagerDeps,
  excludeExternalId?: string,
  maxToArchive = MAX_EVICT_PER_PASS,
  partitionKey = 'default',
): Promise<DiskSlotReclaimResult> {
  return enqueueOrgPass(diskTailByOrg, partitionKey, excludeExternalId, async () => {
    const stoppedAll = await deps.listStopped(50);
    const stoppedKortix = stoppedAll.filter(
      (sb) =>
        sb.managed !== false &&
        sb.id !== excludeExternalId &&
        !isProtectedExternalId(partitionKey, sb.id),
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

    // No stopped Kortix boxes left to archive: stop + archive the oldest IDLE running Kortix box.
    const startedAll = await deps.listStarted(50);
    const runningKortix = startedAll.filter(
      (sb) => sb.managed && sb.id !== excludeExternalId && !isProtectedExternalId(partitionKey, sb.id),
    );
    if (runningKortix.length === 0) {
      logger.warn('[daytona-slot-manager] disk quota hit with 0 eligible sandboxes to archive', {
        partitionKey,
        reason,
      });
      return { stoppedCount: 0, archivedIds: [], freedDiskGb: 0 };
    }
    const stoppedRes = await stopSandboxesLru(
      runningKortix,
      1,
      `disk-quota-stop:${partitionKey}:${reason}`,
      deps,
    );
    if (stoppedRes.evictedIds.length === 0) {
      if (stoppedRes.busyCount > 0) {
        throw new DaytonaAllSandboxesBusyError();
      }
      return { stoppedCount: 0, archivedIds: [], freedDiskGb: 0 };
    }
    const { archivedIds, freedDiskGb } = await archiveSandboxesLru(
      stoppedRes.evictedIds.map((id) => ({ id, disk: 10, lastActivityAt: null, managed: true })),
      1,
      `disk-quota-archive:${partitionKey}:${reason}`,
      deps,
    );
    return { stoppedCount: stoppedRes.evictedIds.length, archivedIds, freedDiskGb };
  });
}

/**
 * Proactive LRU slot manager called before creating or waking a sandbox:
 * keeps running Kortix boxes strictly < `maxRunning` (stopping IDLE LRU first;
 * NEVER stopping sandboxes with active turns) and keeps non-archived Kortix
 * boxes (running + stopped) strictly < `maxNonArchived` (archiving LRU stopped
 * first).
 *
 * Concurrent callers for the same org serialize in order while protecting every
 * caller's `excludeExternalId` so a joiner's sandbox can never be evicted and
 * each open validates its own slot. Throws `DaytonaAllSandboxesBusyError` when
 * a running slot is required and cannot be freed because remaining running
 * sandboxes are busy or protected.
 */
export function ensureDaytonaCapacitySlot(
  reason: string,
  deps: DaytonaSlotManagerDeps,
  limits: { maxRunning: number; maxNonArchived: number; skipDiskEviction?: boolean },
  excludeExternalId?: string,
  partitionKey = 'default',
): Promise<void> {
  return enqueueOrgPass(capacityTailByOrg, partitionKey, excludeExternalId, async () => {
    const skipDiskEviction = Boolean(limits.skipDiskEviction);
    const [startedAll, stoppedAll] = skipDiskEviction
      ? [await deps.listStarted(50), [] as DaytonaStoppedSandboxSummary[]]
      : await Promise.all([deps.listStarted(50), deps.listStopped(50)]);
    const startedOthers = startedAll.filter((sb) => sb.managed && sb.id !== excludeExternalId);
    const startedEvictable = startedOthers.filter((sb) => !isProtectedExternalId(partitionKey, sb.id));
    const stoppedEvictable = stoppedAll.filter(
      (sb) =>
        sb.managed !== false &&
        sb.id !== excludeExternalId &&
        !isProtectedExternalId(partitionKey, sb.id),
    );

    const maxRunningOthers = Math.max(0, limits.maxRunning - 1);
    const needStop = Math.max(0, startedOthers.length - maxRunningOthers);
    const newlyStoppedIds: string[] = [];
    if (needStop > 0) {
      const stopRes = await stopSandboxesLru(
        startedEvictable,
        needStop,
        `lru-concurrency:${partitionKey}:${reason}`,
        deps,
      );
      newlyStoppedIds.push(...stopRes.evictedIds);
      if (stopRes.evictedIds.length < needStop) {
        logger.warn('[daytona-slot-manager] unable to free enough idle running slots; queueing session', {
          partitionKey,
          reason,
          needStop,
          evicted: stopRes.evictedIds.length,
          busyCount: stopRes.busyCount,
          startedOthers: startedOthers.length,
          maxRunning: limits.maxRunning,
        });
        throw new DaytonaAllSandboxesBusyError();
      }
    }

    // Warm resume of an already-`stopped` sandbox occupies 0 net new disk slots:
    // skip archival completely so warm resumes never pay a 15s archive wait.
    if (skipDiskEviction) return;

    const totalOtherNonArchived =
      startedOthers.length +
      stoppedAll.filter((sb) => sb.managed !== false && sb.id !== excludeExternalId).length;
    const maxOtherNonArchived = Math.max(0, limits.maxNonArchived - 1);
    const needArchive = Math.max(0, totalOtherNonArchived - maxOtherNonArchived);
    if (needArchive > 0) {
      const archivePool: DaytonaStoppedSandboxSummary[] = [
        ...stoppedEvictable,
        ...newlyStoppedIds.map((id) => ({ id, disk: 10, lastActivityAt: null, managed: true })),
      ];
      await archiveSandboxesLru(
        archivePool,
        needArchive,
        `lru-disk:${partitionKey}:${reason}`,
        deps,
      );
    }
  });
}
