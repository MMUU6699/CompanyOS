/**
 * Phase 1 unit tests: strict per-user Daytona key isolation (no silent fallback).
 *
 * Proves:
 * 1. With DAYTONA_API_KEY unset and KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK=false,
 *    create/start/stop/getStatus/remove/renewLifecycle/resolveIngress all work
 *    strictly through the connected user's client, and platform getDaytona() is
 *    never invoked.
 * 2. Resolver 'error' (e.g. DB outage) -> getStatus returns 'unknown' (NEVER
 *    'removed'), mutating calls rethrow the error, and platform key is never used.
 * 3. Resolver 'reconnect_required' (e.g. revoked key / org mismatch) -> getStatus
 *    returns 'unknown', mutating calls throw DaytonaReconnectRequiredError.
 * 4. Resolver 'not_connected' -> getStatus returns 'unknown', mutating calls
 *    throw DaytonaNotConnectedError unless KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK=true,
 *    in which case fallback is used and a WARN with sessionId is logged.
 * 5. listManagedRunningSandboxes() returns [] without touching platform Daytona
 *    when fallback is disabled.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { DaytonaContextResolution } from '../../onboarding/daytona-service';
import {
  DaytonaNotConnectedError,
  DaytonaReconnectRequiredError,
} from '../../shared/daytona-errors';

const mockConfig = {
  DAYTONA_API_KEY: '',
  KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK: false,
  DAYTONA_SERVER_URL: 'https://daytona.example.test/api',
  DAYTONA_TARGET: 'eu',
  INTERNAL_KORTIX_ENV: 'test',
  KORTIX_URL: 'https://api.example.com',
  KORTIX_SANDBOX_AUTOARCHIVE_MINUTES: 720,
  KORTIX_SANDBOX_AUTODELETE_MINUTES: -1,
  KORTIX_DAYTONA_MAX_RUNNING_SANDBOXES: 2,
  KORTIX_DAYTONA_MAX_NON_ARCHIVED_SANDBOXES: 3,
  ALLOWED_SANDBOX_PROVIDERS: ['daytona'] as const,
};

const warnLogs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];

mock.module('../../config', () => ({
  config: mockConfig,
  SANDBOX_VERSION: 'test-version',
  KNOWN_PROVIDERS: ['platinum', 'daytona'],
}));

mock.module('../../lib/logger', () => ({
  logger: {
    info: () => {},
    warn: (msg: string, meta?: Record<string, unknown>) => {
      warnLogs.push({ msg, meta });
    },
    error: () => {},
    debug: () => {},
  },
}));

mock.module('../../shared/db', () => ({ db: {}, hasDatabase: true }));

let platformCalls = 0;
let userCalls: string[] = [];
let nextOwnerResolution: DaytonaContextResolution;
let nextExternalResolution: DaytonaContextResolution;
let currentSandboxState = 'started';

function makeUserClient(tag: string) {
  return {
    create: async () => {
      userCalls.push(`${tag}:create`);
      return {
        id: 'sbx-user-created',
        state: 'started',
        getPreviewLink: async () => ({ url: 'https://preview.example.test', token: 'tok' }),
      };
    },
    get: async (id: string) => {
      userCalls.push(`${tag}:get:${id}`);
      return {
        id,
        state: currentSandboxState,
        autoStopInterval: 30,
        autoArchiveInterval: 1440,
        start: async () => {
          userCalls.push(`${tag}:start:${id}`);
          currentSandboxState = 'started';
        },
        stop: async () => {
          userCalls.push(`${tag}:stop:${id}`);
          currentSandboxState = 'stopped';
        },
        refreshActivity: async () => {
          userCalls.push(`${tag}:refreshActivity:${id}`);
        },
        getPreviewLink: async (port: number) => {
          userCalls.push(`${tag}:preview:${id}:${port}`);
          return { url: `https://preview.example.test/${id}/${port}`, token: 'tok' };
        },
        process: {
          executeCommand: async () => ({ exitCode: 0, result: 'ok' }),
        },
      };
    },
    delete: async (sb: { id: string }) => {
      userCalls.push(`${tag}:delete:${sb.id}`);
    },
  };
}

mock.module('../../shared/daytona', () => ({
  getDaytona: () => {
    platformCalls += 1;
    return makeUserClient('platform');
  },
  archiveDaytonaSandboxById: async () => true,
  getDaytonaSandboxStateById: async () => 'stopped',
  isDaytonaComputeQuotaError: () => false,
  isDaytonaDiskQuotaError: () => false,
  listStartedDaytonaSandboxesOldestFirst: async () => [],
  listStoppedDaytonaSandboxesOldestFirst: async () => [],
  stopDaytonaSandboxById: async () => true,
}));

mock.module('../../projects/compute-quota-guard', () => ({
  ensureDaytonaCapacitySlot: async () => ({ evictedIds: [], archivedIds: [] }),
  evictIdleRunningDaytonaSandboxes: async () => ({ evictedIds: [] }),
  reclaimDaytonaDiskSlots: async () => ({ archivedIds: [] }),
}));

mock.module('../../projects/disk-quota-guard', () => ({
  triggerEmergencyDiskArchiveSweep: () => {},
}));

mock.module('../service-key', () => ({
  serviceKeyForExternalId: async () => 'svc-key',
}));

mock.module('../sandbox-frontend-url', () => ({
  sandboxFrontendBaseUrl: () => 'https://app.example.com',
}));

mock.module('../sandbox-ownership', () => ({
  sandboxOwnershipMarker: async () => 'owner-marker',
}));

mock.module('../../onboarding/daytona-service', () => ({
  resolveDaytonaContextForOwner: async () => nextOwnerResolution,
  resolveDaytonaContextForExternalId: async () => nextExternalResolution,
  ensureUserSnapshotActive: async () => ({ snapshotName: 'kortix-sandbox-test' }),
  invalidateUserDaytonaCache: () => {},
  isDaytonaCredentialRejectedError: (err: unknown) =>
    err instanceof Error && err.message.includes('Invalid credentials'),
  rememberExternalIdOwner: () => {},
}));

const { DaytonaProvider } = await import('./daytona');
const { getProvider } = await import('./index');

beforeEach(() => {
  mockConfig.DAYTONA_API_KEY = '';
  mockConfig.KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK = false;
  platformCalls = 0;
  userCalls = [];
  warnLogs.length = 0;
  currentSandboxState = 'started';

  const userCtx = {
    userId: 'user-123',
    apiKey: 'dtn_user_secret_key',
    daytonaOrgId: 'org-user-123',
    daytonaRegion: 'eu',
    snapshotName: 'kortix-sandbox-test',
    snapshotStatus: 'active' as const,
    client: makeUserClient('user') as any,
  };
  nextOwnerResolution = { kind: 'user', ctx: userCtx };
  nextExternalResolution = { kind: 'user', ctx: userCtx };
});

describe('DaytonaProvider per-user key isolation (Phase 1)', () => {
  test('create/start/stop/getStatus/remove/renewLifecycle/resolveIngress all work with DAYTONA_API_KEY unset', async () => {
    const provider = getProvider('daytona');
    expect(provider).toBeInstanceOf(DaytonaProvider);

    const created = await provider.create({
      userId: 'user-123',
      accountId: 'acct-1',
      envVars: { KORTIX_TOKEN: 'tok', KORTIX_SESSION_ID: 'sess-1' },
      metadata: { session_id: 'sess-1' },
    });
    expect(created.externalId).toBe('sbx-user-created');
    expect(created.metadata?.daytonaOrgId).toBe('org-user-123');

    expect(await provider.getStatus('sbx-user-created')).toBe('running');

    await provider.renewLifecycle('sbx-user-created');
    await provider.stop('sbx-user-created');
    expect(await provider.getStatus('sbx-user-created')).toBe('stopped');

    await provider.start('sbx-user-created');
    expect(await provider.getStatus('sbx-user-created')).toBe('running');

    const ingress = await provider.resolveIngress('sbx-user-created', {
      port: 8000,
      transport: 'http',
    });
    expect(ingress.url).toBe('https://preview.example.test/sbx-user-created/8000');

    await provider.remove('sbx-user-created');

    expect(platformCalls).toBe(0);
    expect(userCalls).toContain('user:create');
    expect(userCalls).toContain('user:stop:sbx-user-created');
    expect(userCalls).toContain('user:start:sbx-user-created');
    expect(userCalls).toContain('user:delete:sbx-user-created');
  });

  test('DB/resolver error maps getStatus -> unknown (NEVER removed) and rethrows on mutating ops without platform fallback', async () => {
    const dbErr = new Error('connection refused to Postgres');
    nextExternalResolution = { kind: 'error', cause: dbErr, message: dbErr.message };
    nextOwnerResolution = { kind: 'error', cause: dbErr, message: dbErr.message };

    const provider = new DaytonaProvider();
    expect(await provider.getStatus('sbx-err-1')).toBe('unknown');
    await expect(provider.stop('sbx-err-1')).rejects.toThrow('connection refused');
    await expect(provider.remove('sbx-err-1')).rejects.toThrow('connection refused');
    await expect(provider.start('sbx-err-1')).rejects.toThrow('connection refused');
    await expect(
      provider.create({
        userId: 'user-123',
        accountId: 'acct-1',
        envVars: { KORTIX_TOKEN: 'tok', KORTIX_SESSION_ID: 'sess-err' },
      }),
    ).rejects.toThrow('connection refused');
    expect(platformCalls).toBe(0);
  });

  test('reconnect_required maps getStatus -> unknown and throws DaytonaReconnectRequiredError on mutating ops', async () => {
    nextExternalResolution = {
      kind: 'reconnect_required',
      userId: 'user-123',
      message: 'Org mismatch: reconnect Daytona',
    };
    nextOwnerResolution = nextExternalResolution;

    const provider = new DaytonaProvider();
    expect(await provider.getStatus('sbx-reconn-1')).toBe('unknown');
    await expect(provider.stop('sbx-reconn-1')).rejects.toBeInstanceOf(DaytonaReconnectRequiredError);
    await expect(provider.start('sbx-reconn-1')).rejects.toBeInstanceOf(DaytonaReconnectRequiredError);
    await expect(provider.remove('sbx-reconn-1')).rejects.toBeInstanceOf(DaytonaReconnectRequiredError);
    expect(platformCalls).toBe(0);
  });

  test('not_connected throws DaytonaNotConnectedError and returns unknown from getStatus by default (even if DAYTONA_API_KEY is set)', async () => {
    mockConfig.DAYTONA_API_KEY = 'dtn_platform_legacy_key';
    mockConfig.KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK = false;
    nextExternalResolution = { kind: 'not_connected', userId: 'user-unconnected', reason: 'no_credentials' };
    nextOwnerResolution = nextExternalResolution;

    const provider = new DaytonaProvider();
    expect(await provider.getStatus('sbx-unconn-1')).toBe('unknown');
    await expect(provider.stop('sbx-unconn-1')).rejects.toBeInstanceOf(DaytonaNotConnectedError);
    await expect(provider.start('sbx-unconn-1')).rejects.toBeInstanceOf(DaytonaNotConnectedError);
    await expect(provider.remove('sbx-unconn-1')).rejects.toBeInstanceOf(DaytonaNotConnectedError);
    await expect(
      provider.create({
        userId: 'user-unconnected',
        accountId: 'acct-1',
        snapshot: 'legacy-snap',
        envVars: { KORTIX_TOKEN: 'tok', KORTIX_SESSION_ID: 'sess-unconn' },
      }),
    ).rejects.toBeInstanceOf(DaytonaNotConnectedError);
    expect(platformCalls).toBe(0);
  });

  test('opt-in KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK=true allows fallback for not_connected and logs WARN with sessionId', async () => {
    mockConfig.DAYTONA_API_KEY = 'dtn_platform_legacy_key';
    mockConfig.KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK = true;
    nextExternalResolution = { kind: 'not_connected', userId: null, reason: 'no_owner_recorded' };
    nextOwnerResolution = nextExternalResolution;

    const provider = new DaytonaProvider();
    expect(await provider.getStatus('sbx-legacy-1')).toBe('running');
    expect(platformCalls).toBe(1);
    expect(warnLogs.some((l) => l.meta?.sessionId === 'sbx-legacy-1')).toBe(true);

    // Even with fallback enabled, a DB error MUST NOT fall back to platform key.
    platformCalls = 0;
    nextExternalResolution = { kind: 'error', cause: new Error('db down'), message: 'db down' };
    expect(await provider.getStatus('sbx-legacy-2')).toBe('unknown');
    expect(platformCalls).toBe(0);
  });

  test('listManagedRunningSandboxes() skips platform Daytona org when fallback is disabled', async () => {
    mockConfig.DAYTONA_API_KEY = 'dtn_platform_legacy_key';
    mockConfig.KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK = false;
    const provider = new DaytonaProvider();
    const list = await provider.listManagedRunningSandboxes();
    expect(list).toEqual([]);
    expect(platformCalls).toBe(0);
  });
});
