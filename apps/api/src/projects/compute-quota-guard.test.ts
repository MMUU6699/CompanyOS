import { afterEach, describe, expect, mock, test } from 'bun:test';

// Stub config + db before importing compute-quota-guard / shared/daytona.
mock.module('../config', () => ({
  config: {
    DAYTONA_API_KEY: undefined,
    DAYTONA_SERVER_URL: 'https://daytona.test/api',
    DAYTONA_TARGET: 'eu',
  },
}));
mock.module('../shared/db', () => ({
  hasDatabase: false,
  db: {},
}));

const {
  ensureDaytonaCapacitySlot,
  evictIdleRunningDaytonaSandboxes,
  reclaimDaytonaDiskSlots,
} = await import('./compute-quota-guard');
const {
  fetchDaytonaOrgLimits,
  getLearnedDaytonaOrgCap,
  recordLearnedDaytonaOrgCap,
  resetDaytonaOrgLimitsCache,
} = await import('../shared/daytona');
const { isDaytonaAllSandboxesBusyError } = await import('../shared/daytona-errors');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDaytonaOrgLimitsCache();
});

describe('compute-quota-guard — eviction safety & concurrent open serialization', () => {
  test('NEVER evicts sandboxes with active turns; throws DaytonaAllSandboxesBusyError when all running boxes are busy', async () => {
    const running = [
      { id: 'sb-busy-1', memory: 4, cpu: 2, lastActivityAt: '2026-11-24T00:01:00Z', createdAt: null, managed: true },
      { id: 'sb-busy-2', memory: 4, cpu: 2, lastActivityAt: '2026-11-24T00:02:00Z', createdAt: null, managed: true },
    ];
    const stoppedCalls: string[] = [];

    const deps = {
      listStarted: async () => [...running],
      listStopped: async () => [],
      stop: async (id: string) => {
        stoppedCalls.push(id);
        return true;
      },
      archive: async () => true,
      getState: async () => 'stopped',
      isBusy: () => true,
      sleep: async () => undefined,
    };

    let caught: unknown = null;
    try {
      await ensureDaytonaCapacitySlot(
        'open-busy-test',
        deps,
        { maxRunning: 2, maxNonArchived: 3, skipDiskEviction: true },
        'sb-new',
        'org-busy',
      );
    } catch (err) {
      caught = err;
    }

    expect(stoppedCalls).toEqual([]);
    expect(isDaytonaAllSandboxesBusyError(caught)).toBe(true);
    expect((caught as { code?: string; retriable?: boolean }).code).toBe('DAYTONA_QUOTA_EXCEEDED');
    expect((caught as { retriable?: boolean }).retriable).toBe(true);
  });

  test('stops ONLY idle sandboxes when mixed busy + idle exist', async () => {
    const busyIds = new Set(['sb-1']);
    const running = new Map([
      ['sb-1', { id: 'sb-1', memory: 4, cpu: 2, lastActivityAt: '2026-11-24T00:00:01Z', createdAt: null, managed: true }],
      ['sb-2', { id: 'sb-2', memory: 4, cpu: 2, lastActivityAt: '2026-11-24T00:00:02Z', createdAt: null, managed: true }],
    ]);
    const stoppedCalls: string[] = [];

    const deps = {
      listStarted: async () => Array.from(running.values()),
      listStopped: async () => [],
      stop: async (id: string) => {
        stoppedCalls.push(id);
        running.delete(id);
        return true;
      },
      archive: async () => true,
      getState: async (id: string) => (running.has(id) ? 'started' : 'stopped'),
      isBusy: (id: string) => busyIds.has(id),
      sleep: async () => undefined,
    };

    await ensureDaytonaCapacitySlot(
      'open-mixed',
      deps,
      { maxRunning: 2, maxNonArchived: 3, skipDiskEviction: true },
      'sb-3',
      'org-mixed',
    );

    // sb-1 was older but busy; sb-2 was idle and must be the sole eviction.
    expect(stoppedCalls).toEqual(['sb-2']);
    expect(running.has('sb-1')).toBe(true);
  });

  test('open 6 sessions quickly with maxRunning=2: never evicts a busy box or a concurrent joiner excludeExternalId', async () => {
    // 2 initial boxes: sb-busy (active turn) + sb-idle (idle).
    // 6 concurrent opens arrive for sb-open-1..sb-open-6 with maxRunning=2.
    const busyIds = new Set(['sb-busy']);
    const running = new Map([
      ['sb-busy', { id: 'sb-busy', memory: 4, cpu: 2, lastActivityAt: '2026-11-24T00:00:01Z', createdAt: null, managed: true }],
      ['sb-idle', { id: 'sb-idle', memory: 4, cpu: 2, lastActivityAt: '2026-11-24T00:00:02Z', createdAt: null, managed: true }],
    ]);
    const evicted: string[] = [];
    const joinerIds = ['sb-open-1', 'sb-open-2', 'sb-open-3', 'sb-open-4', 'sb-open-5', 'sb-open-6'];
    // Make sb-open-1 already started as well to prove a joiner's excludeExternalId is NEVER evicted
    // by earlier concurrent callers in the same burst!
    running.set('sb-open-1', {
      id: 'sb-open-1',
      memory: 4,
      cpu: 2,
      lastActivityAt: '2026-11-24T00:00:00Z',
      createdAt: null,
      managed: true,
    });

    const deps = {
      listStarted: async () => Array.from(running.values()),
      listStopped: async () => [],
      stop: async (id: string) => {
        evicted.push(id);
        running.delete(id);
        return true;
      },
      archive: async () => true,
      getState: async (id: string) => (running.has(id) ? 'started' : 'stopped'),
      isBusy: (id: string) => busyIds.has(id),
      sleep: async () => undefined,
    };

    const outcomes = await Promise.allSettled(
      joinerIds.map(async (extId) => {
        await ensureDaytonaCapacitySlot(
          `burst:${extId}`,
          deps,
          { maxRunning: 2, maxNonArchived: 3, skipDiskEviction: true },
          extId,
          'org-burst-6',
        );
        // Simulate starting this session's box once a slot is granted.
        running.set(extId, {
          id: extId,
          memory: 4,
          cpu: 2,
          lastActivityAt: new Date().toISOString(),
          createdAt: null,
          managed: true,
        });
        busyIds.add(extId);
        return extId;
      }),
    );

    // 1. ZERO busy sandboxes were ever stopped.
    expect(evicted).not.toContain('sb-busy');
    // 2. Concurrent joiner sb-open-1 was protected across the entire burst and NEVER evicted.
    expect(evicted).not.toContain('sb-open-1');
    // 3. sb-idle was stopped cleanly to make room.
    expect(evicted).toContain('sb-idle');
    // 4. Every rejected open received typed DaytonaAllSandboxesBusyError (never silent corruption).
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) {
      expect(isDaytonaAllSandboxesBusyError(r.reason)).toBe(true);
    }
    // 5. Running count never exceeded maxRunning=2 after the initial 3 -> 2 drain.
    expect(running.size).toBeLessThanOrEqual(2);
  });

  test('reactive evictIdleRunningDaytonaSandboxes and reclaimDaytonaDiskSlots respect busy sandboxes', async () => {
    const busyDeps = {
      listStarted: async () => [
        { id: 'sb-active', memory: 4, cpu: 2, lastActivityAt: '2026-11-24T00:00:01Z', createdAt: null, managed: true },
      ],
      listStopped: async () => [],
      stop: async () => true,
      archive: async () => true,
      getState: async () => 'started',
      isBusy: () => true,
      sleep: async () => undefined,
    };

    await expect(
      evictIdleRunningDaytonaSandboxes('reactive-mem', busyDeps, undefined, 'org-reactive-1'),
    ).rejects.toMatchObject({ name: 'DaytonaAllSandboxesBusyError', code: 'DAYTONA_QUOTA_EXCEEDED' });

    await expect(
      reclaimDaytonaDiskSlots('reactive-disk', busyDeps, undefined, 1, 'org-reactive-2'),
    ).rejects.toMatchObject({ name: 'DaytonaAllSandboxesBusyError', code: 'DAYTONA_QUOTA_EXCEEDED' });
  });
});

describe('Daytona live org limits & learned caps', () => {
  test('fetchDaytonaOrgLimits reads GET /organizations/:orgId/usage and caches per org', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls += 1;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe('https://daytona.test/api/organizations/org-tier2/usage');
      return new Response(
        JSON.stringify({
          totalCpuQuota: 20,
          totalMemoryQuota: 24,
          totalDiskQuota: 60,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const first = await fetchDaytonaOrgLimits('dtn_live_key', 'org-tier2', {
      sandboxCpu: 2,
      sandboxMemoryGb: 4,
      sandboxDiskGb: 10,
    });
    expect(first.source).toBe('api');
    expect(first.maxRunningSandboxes).toBe(6); // min(24/4=6, 20/2=10)
    expect(first.maxNonArchivedSandboxes).toBe(6); // 60/10=6

    // Second call hits 10-min cache without another HTTP round-trip.
    const second = await fetchDaytonaOrgLimits('dtn_live_key', 'org-tier2');
    expect(second.maxRunningSandboxes).toBe(6);
    expect(calls).toBe(1);
  });

  test('recordLearnedDaytonaOrgCap lowers effective cap and stays bounded >= 1', () => {
    recordLearnedDaytonaOrgCap('org-learn', 'running', 2);
    expect(getLearnedDaytonaOrgCap('org-learn')).toEqual({ maxRunning: 2, maxNonArchived: undefined });
    recordLearnedDaytonaOrgCap('org-learn', 'running', 1);
    expect(getLearnedDaytonaOrgCap('org-learn')).toEqual({ maxRunning: 1, maxNonArchived: undefined });
    recordLearnedDaytonaOrgCap('org-learn', 'disk', 0);
    expect(getLearnedDaytonaOrgCap('org-learn')).toEqual({ maxRunning: 1, maxNonArchived: 1 });
  });
});
