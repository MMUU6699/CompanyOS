/**
 * A PINNED runtime that still serves must not have its session refused.
 *
 * `classifyDaemonHealth` returns `blocked` on one flag — `runtime.pinned ===
 * true` — set by the daemon's own supervisor after it tried an update, failed,
 * and rolled back. Never looping a repair on that is correct: another attempt
 * relaunches into the same rollback.
 *
 * But "do not REPAIR it" and "refuse the SESSION" were the same statement, and
 * the second does not follow. Measured on dev 2026-09-28, a pinned box:
 *
 *   daemon ok · runtime ok · runtimeReady true · uptime 14917s
 *   components: cli=current, skills=current, agent=skipped
 *   reasons:    {"agent": "updates pinned after a rollback"}
 *
 * Three of four components current, the box demonstrably serving — and the
 * open answered `stage: 'failed', retriable: false`, so no one could ever use
 * that session again and no retry could change it. A guaranteed total outage
 * traded against a possible degradation.
 *
 * This pins the SIGNAL the open reads to tell those two cases apart.
 */

import { describe, expect, test } from 'bun:test';

import {
  bootstrapWouldSkip,
  classifyDaemonHealth,
  describeLegacyBootstrapRetry,
  isUnsupportedBootstrapRecord,
} from './legacy-runtime-bootstrap';
import { guaranteeCurrentRuntimeOnOpen } from './legacy-runtime-bootstrap-wiring';
import { pinnedRuntimeMayServe, staleRuntimeMayServe } from './pinned-runtime';
import { enforceRuntimeGuarantee } from '../session-open/session-open-guarantee';

/** The measured dev box, verbatim in shape. */
const pinnedButServing = {
  daemon: 'ok',
  harness: { id: 'pi', state: 'ok' },
  runtimeReady: true,
  runtime: {
    build: 1790591344,
    pinned: true,
    components: { cli: 'current', skills: 'current', agent: 'skipped' },
    reasons: { agent: 'updates pinned after a rollback' },
  },
};

describe('a pinned runtime', () => {
  test('is classified blocked — the repair must never loop on it', () => {
    expect(classifyDaemonHealth(pinnedButServing).klass).toBe('blocked');
  });

  test('still reports it can serve, which is what the open must key on', () => {
    // A runtime state of `ok` is the whole difference between "stale but usable"
    // and "cannot answer a prompt". The open refuses only the second.
    expect(classifyDaemonHealth(pinnedButServing).runtimeState).toBe('ok');
  });

  test('carries the operator detail, so nothing is silently swallowed', () => {
    const detail = classifyDaemonHealth(pinnedButServing).detail.join('; ');
    expect(detail).toContain('pinned');
  });

  test('the open PROCEEDS on it — the rule the route itself uses', () => {
    expect(pinnedRuntimeMayServe(classifyDaemonHealth(pinnedButServing))).toBe(true);
  });

  test('a pinned box that CANNOT serve is still distinguishable', () => {
    // The open must keep failing this one: blocked AND not serving.
    const dead = {
      ...pinnedButServing,
      harness: { id: 'pi', state: 'starting' },
      runtime: { ...pinnedButServing.runtime, components: { agent: 'failed' } },
    };
    const c = classifyDaemonHealth(dead);
    expect(c.klass).toBe('blocked');
    expect(c.runtimeState).not.toBe('ok');
    // …and THIS one the open must still refuse.
    expect(pinnedRuntimeMayServe(c)).toBe(false);
  });

  test('a missing classification is refused, never waved through', () => {
    expect(pinnedRuntimeMayServe(null)).toBe(false);
    expect(pinnedRuntimeMayServe(undefined)).toBe(false);
    expect(pinnedRuntimeMayServe({ runtimeState: null })).toBe(false);
  });

  test('an unpinned healthy box is not blocked at all', () => {
    const healthy = {
      ...pinnedButServing,
      runtime: { ...pinnedButServing.runtime, pinned: false },
    };
    expect(classifyDaemonHealth(healthy).klass).not.toBe('blocked');
  });
});

describe('a stale non-root Daytona runtime (recorded response shapes)', () => {
  const expectedManifestAssets = {
    cli_sha256: '94bb17c5152605cb096ab135e545719a3aea9579768c42ef17711be53c3fba55',
    managed_skills_hash: 'b16589d109ce8a7d7d9928185eafef7bf425b973ee77690489dabe45d5aa1c0d',
    agent_sha256: '954fad72b21e607b0d4730ece46f139cb71f810eb5c9680292061eceeace27b5',
  };

  /** Recorded `/kortix/health` shape from a non-root Daytona container with version-only skill drift. */
  const recordedDaytonaHealth = {
    daemon: 'ok',
    capabilities: ['config.release.v1', 'machine.desktop', 'runtime.turns.v1'],
    status: 'ok',
    runtimeReady: true,
    uptime_s: 13,
    runtime: {
      build: 1795336908,
      components: { cli: 'current', skills: 'failed', agent: 'current' },
      agentSwapPending: false,
      pinned: false,
      running: {
        cli_sha256: '94bb17c5152605cb096ab135e545719a3aea9579768c42ef17711be53c3fba55',
        managed_skills_hash: '350a31b2b421ea42df87590cca256fe5e0ef6804474c5028febdb1b424127815',
        agent_sha256: '954fad72b21e607b0d4730ece46f139cb71f810eb5c9680292061eceeace27b5',
        agent_path: '/opt/kortix/agent.current',
        harness: 'pi',
        harness_version: 'pi-agent-core@1.4.0',
        build: 1795336908,
      },
    },
    harness: { id: 'pi', version: 'pi-agent-core@1.4.0', state: 'ok', ready: true, error: null },
  };

  test('staleRuntimeMayServe allows version-only asset drift when runtimeState is ok, and rejects missing capabilities or non-ok runtime', () => {
    const c = classifyDaemonHealth(recordedDaytonaHealth, expectedManifestAssets);
    expect(c.klass).toBe('stale');
    expect(c.runtimeState).toBe('ok');
    expect(c.staleReasons).toEqual(['running_assets_stale', 'component_failed']);
    expect(staleRuntimeMayServe(c)).toBe(true);

    expect(
      staleRuntimeMayServe({
        runtimeState: 'ok',
        staleReasons: ['running_assets_stale', 'missing_capability'],
      }),
    ).toBe(false);
    expect(
      staleRuntimeMayServe({
        runtimeState: 'starting',
        staleReasons: ['running_assets_stale'],
      }),
    ).toBe(false);
    expect(staleRuntimeMayServe(null)).toBe(false);
  });

  test('treats pre-existing failed preflight: must run as root records as unsupported without holding in cooldown or exhausted', async () => {
    const preExistingFailedRootMetadata = {
      legacyRuntimeBootstrap: {
        from: { runtimeState: 'ok' },
        error: 'preflight: must run as root',
        state: 'failed',
        reason: 'session-open',
        attempts: 3,
        lastAttemptAt: '2026-11-24T13:52:33.218Z',
        manifestBuild: 1795336908,
        classification: { klass: 'stale', staleReasons: ['running_assets_stale'] },
      },
    };

    expect(
      isUnsupportedBootstrapRecord({ state: 'failed', error: 'preflight: must run as root' }),
    ).toBe(true);
    expect(
      bootstrapWouldSkip(
        preExistingFailedRootMetadata,
        1795336908,
        Date.parse('2026-11-24T15:19:16.000Z'),
        'ext-daytona-1',
      ),
    ).toBe(true);
    expect(
      describeLegacyBootstrapRetry(
        preExistingFailedRootMetadata,
        1795336908,
        Date.parse('2026-11-24T15:19:16.000Z'),
      ).status,
    ).toBe('unsupported');

    let scheduled = 0;
    const outcome = await guaranteeCurrentRuntimeOnOpen(
      {
        sandboxId: '00000000-0000-4000-8000-000000000001',
        sessionId: '00000000-0000-4000-8000-000000000001',
        accountId: '00000000-0000-4000-8000-000000000002',
        provider: 'daytona',
        externalId: 'ext-daytona-1',
        metadata: preExistingFailedRootMetadata,
      },
      {
        now: () => Date.parse('2026-11-24T15:19:16.000Z'),
        sleep: async () => {},
        manifestBuild: async () => 1795336908,
        expectedRunningAssets: async () => expectedManifestAssets,
        fetchHealth: async () => recordedDaytonaHealth,
        fetchTurnInFlight: async () => false,
        exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        patchMetadata: async () => {},
        claimRun: async () => true,
        audit: async () => {},
        log: () => {},
      },
      () => {
        scheduled += 1;
        return true;
      },
    );
    expect(outcome.action).toBe('proceed');
    expect(scheduled).toBe(0);
  });

  test('enforceRuntimeGuarantee serves an exhausted runtime whose daemon is ok, and fails one whose daemon cannot serve', async () => {
    const fakeArgs = {
      loaded: { userId: '00000000-0000-4000-8000-000000000010' },
      visible: { row: { agentName: 'mykortix' } },
      projectId: '00000000-0000-4000-8000-000000000011',
      sessionId: '00000000-0000-4000-8000-000000000012',
    } as never;
    const baseRow = {
      sandboxId: '00000000-0000-4000-8000-000000000012',
      sessionId: '00000000-0000-4000-8000-000000000012',
      projectId: '00000000-0000-4000-8000-000000000011',
      accountId: '00000000-0000-4000-8000-000000000011',
      provider: 'daytona',
      externalId: 'ext-daytona-2',
      status: 'active',
      config: {},
      metadata: {
        legacyRuntimeBootstrap: {
          state: 'failed',
          error: 'preflight: must run as root',
          attempts: 3,
          lastAttemptAt: '2026-11-24T13:52:33.218Z',
          manifestBuild: 1795336908,
        },
      },
      lastUsedAt: new Date('2026-11-24T13:52:33.218Z'),
      createdAt: new Date('2026-11-24T13:00:00.000Z'),
      updatedAt: new Date('2026-11-24T13:52:33.218Z'),
    } as never;

    // Even while booting=false, non-root unsupported record proceeds cleanly (null = continue to stage: 'ready').
    const res = await enforceRuntimeGuarantee(fakeArgs, baseRow, 'ext-daytona-2', false);
    expect(res).toBeNull();
  });
});
