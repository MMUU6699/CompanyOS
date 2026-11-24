/**
 * Phase 3 unit tests: snapshot read-only status, explicit retry + backoff cap,
 * shared single-flight DB state persistence across all org users, and typed
 * getPinnedGhcrSandboxImage() errors.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const mockConfig = {
  DAYTONA_API_KEY: '',
  KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK: false,
  DAYTONA_SERVER_URL: 'https://daytona.example.test/api',
  DAYTONA_TARGET: 'eu',
  API_KEY_SECRET: 'test-api-key-secret-for-unit-tests-0123456789',
  DAYTONA_CREDENTIALS_ENCRYPTION_KEY: 'test-daytona-enc-key-0123456789abcdef',
  KORTIX_SANDBOX_GHCR_IMAGE: 'ghcr.io/mmuu6699/kortix-sandbox:20261121-da3f5cdd',
  KORTIX_DAYTONA_KEY_TTL_DAYS: 0,
  KORTIX_DAYTONA_MAX_ACTIVE_FLOWS_PER_IP: 5,
};

mock.module('../config', () => ({ config: mockConfig }));
mock.module('../lib/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
mock.module('../shared/daytona', () => ({
  stopDaytonaSandboxById: async () => true,
}));

interface CredRow {
  userId: string;
  encryptedApiKey: string;
  encryptionIv: string;
  encryptionTag: string;
  daytonaOrgId: string;
  daytonaRegion: string;
  daytonaKeyName: string | null;
  daytonaKeyExpiresAt: Date | null;
  previousDaytonaOrgId: string | null;
  previousOrgReplacedAt: Date | null;
  snapshotName: string | null;
  snapshotStatus: 'pending' | 'pulling' | 'active' | 'inactive' | 'failed';
  snapshotError: string | null;
  snapshotAttempts: number | null;
  snapshotNextRetryAt: Date | null;
  maxRunningSandboxes: number | null;
  maxNonArchivedSandboxes: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const credsTable = new Map<string, CredRow>();

function extractStringParams(cond: any, out: unknown[] = []): unknown[] {
  if (!cond) return out;
  if (Array.isArray(cond)) {
    for (const item of cond) extractStringParams(item, out);
    return out;
  }
  if (typeof cond === 'object') {
    if ('value' in cond && (typeof cond.value === 'string' || cond.value instanceof Date || Array.isArray(cond.value))) {
      out.push(cond.value);
    }
    if ('queryChunks' in cond) extractStringParams(cond.queryChunks, out);
  }
  return out;
}

const fakeDb: any = {
  select: () => ({
    from: () => ({
      where: (cond: any) => ({
        limit: async () => {
          const params = extractStringParams(cond);
          const all = [...credsTable.values()];
          const byUser = all.filter((c) => params.includes(c.userId));
          if (byUser.length > 0) return byUser;
          const byOrg = all.filter((c) => params.includes(c.daytonaOrgId));
          if (byOrg.length > 0) return byOrg;
          return all;
        },
      }),
    }),
  }),
  update: () => ({
    set: (patch: any) => ({
      where: (cond: any) => {
        const params = extractStringParams(cond);
        for (const row of credsTable.values()) {
          if (params.includes(row.userId) || params.includes(row.daytonaOrgId)) {
            Object.assign(row, patch);
          }
        }
        return Promise.resolve([]);
      },
    }),
  }),
};

mock.module('../shared/db', () => ({ db: fakeDb, hasDatabase: true }));

const { encryptDaytonaApiKey } = await import('./daytona-crypto');
const {
  MAX_SNAPSHOT_ATTEMPTS,
  ensureUserSnapshot,
  getDaytonaOnboardingStatus,
  getPinnedGhcrSandboxImage,
  invalidateUserDaytonaCache,
  retryUserDaytonaSnapshot,
} = await import('./daytona-service');

const originalFetch = global.fetch;

function seedCred(
  userId: string,
  orgId: string,
  overrides: Partial<CredRow> = {},
): CredRow {
  const enc = encryptDaytonaApiKey(userId, `dtn_key_${userId}_1234567890`);
  const row: CredRow = {
    userId,
    encryptedApiKey: enc.encryptedApiKey,
    encryptionIv: enc.encryptionIv,
    encryptionTag: enc.encryptionTag,
    daytonaOrgId: orgId,
    daytonaRegion: 'eu',
    daytonaKeyName: 'kortix-app-flow-test',
    daytonaKeyExpiresAt: null,
    previousDaytonaOrgId: null,
    previousOrgReplacedAt: null,
    snapshotName: 'kortix-sandbox-20261121-da3f5cdd',
    snapshotStatus: 'failed',
    snapshotError: 'DAYTONA_SNAPSHOT_FAILED',
    snapshotAttempts: 0,
    snapshotNextRetryAt: null,
    maxRunningSandboxes: null,
    maxNonArchivedSandboxes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  credsTable.set(userId, row);
  return row;
}

beforeEach(() => {
  credsTable.clear();
  mockConfig.KORTIX_SANDBOX_GHCR_IMAGE = 'ghcr.io/mmuu6699/kortix-sandbox:20261121-da3f5cdd';
  global.fetch = originalFetch;
  invalidateUserDaytonaCache('user-ro');
  invalidateUserDaytonaCache('user-flight-a');
  invalidateUserDaytonaCache('user-flight-b');
  invalidateUserDaytonaCache('user-cap');
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('Phase 3 snapshot lifecycle', () => {
  test('getPinnedGhcrSandboxImage throws typed DaytonaStructuredError on :latest or tagless image', () => {
    mockConfig.KORTIX_SANDBOX_GHCR_IMAGE = 'ghcr.io/mmuu6699/kortix-sandbox:latest';
    expect(() => getPinnedGhcrSandboxImage()).toThrow();
    try {
      getPinnedGhcrSandboxImage();
    } catch (err: any) {
      expect(err.code).toBe('DAYTONA_SNAPSHOT_CONFIG_INVALID');
      expect(err.httpStatus).toBe(500);
    }

    mockConfig.KORTIX_SANDBOX_GHCR_IMAGE = 'ghcr.io/mmuu6699/kortix-sandbox';
    try {
      getPinnedGhcrSandboxImage();
    } catch (err: any) {
      expect(err.code).toBe('DAYTONA_SNAPSHOT_CONFIG_INVALID');
      expect(err.httpStatus).toBe(500);
    }
  });

  test('GET /status (getDaytonaOnboardingStatus) is strictly read-only and NEVER calls POST/DELETE/PATCH on Daytona', async () => {
    seedCred('user-ro', 'org-ro-1', { snapshotStatus: 'pulling', snapshotError: null });
    const methodsCalled: string[] = [];
    global.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      methodsCalled.push((init?.method || 'GET').toUpperCase());
      return new Response(
        JSON.stringify({ id: 'snap-1', name: 'kortix-sandbox-20261121-da3f5cdd', state: 'error', errorReason: 'pull failed' }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const status1 = await getDaytonaOnboardingStatus('user-ro');
    expect(status1.snapshotStatus).toBe('failed');
    expect(methodsCalled).toEqual(['GET']);

    // Polling again when already 'failed' must NOT even hit Daytona or delete/recreate!
    const status2 = await getDaytonaOnboardingStatus('user-ro');
    expect(status2.snapshotStatus).toBe('failed');
    expect(methodsCalled).toEqual(['GET']);
  });

  test('single-flight ensureUserSnapshot updates ALL users in the org even when started pre-claim (userId undefined)', async () => {
    seedCred('user-flight-a', 'org-shared-snap', { snapshotStatus: 'pulling', snapshotError: null });
    seedCred('user-flight-b', 'org-shared-snap', { snapshotStatus: 'pulling', snapshotError: null });

    let getCalls = 0;
    global.fetch = mock(async () => {
      getCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(
        JSON.stringify({ id: 'snap-ok', name: 'kortix-sandbox-20261121-da3f5cdd', state: 'active' }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    // Pre-claim starts with userId: undefined; user-flight-a joins the same flight.
    const [r1, r2] = await Promise.all([
      ensureUserSnapshot({
        apiKey: 'dtn_preclaim_key_1234567890',
        daytonaOrgId: 'org-shared-snap',
        daytonaRegion: 'eu',
      }),
      ensureUserSnapshot({
        userId: 'user-flight-a',
        apiKey: 'dtn_key_user-flight-a_1234567890',
        daytonaOrgId: 'org-shared-snap',
        daytonaRegion: 'eu',
      }),
    ]);

    expect(getCalls).toBe(1);
    expect(r1.snapshotStatus).toBe('active');
    expect(r2.snapshotStatus).toBe('active');
    expect(credsTable.get('user-flight-a')?.snapshotStatus).toBe('active');
    expect(credsTable.get('user-flight-b')?.snapshotStatus).toBe('active');
  });

  test('bounded automatic retries stop at MAX_SNAPSHOT_ATTEMPTS and explicit retry resets budget and recreates once', async () => {
    seedCred('user-cap', 'org-cap-1', {
      snapshotStatus: 'failed',
      snapshotAttempts: MAX_SNAPSHOT_ATTEMPTS,
      snapshotNextRetryAt: new Date(Date.now() + 60_000),
    });

    const calls: string[] = [];
    global.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      const m = (init?.method || 'GET').toUpperCase();
      calls.push(`${m} ${String(url)}`);
      if (m === 'GET') {
        return new Response(
          JSON.stringify({ id: 'snap-err', name: 'kortix-sandbox-20261121-da3f5cdd', state: 'error', errorReason: 'oom' }),
          { status: 200 },
        );
      }
      if (m === 'DELETE') return new Response(null, { status: 204 });
      if (m === 'POST') return new Response(JSON.stringify({ id: 'snap-new' }), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    // Automatic ensure when budget is exhausted MUST NOT delete or POST /snapshots.
    const blocked = await ensureUserSnapshot({
      userId: 'user-cap',
      apiKey: 'dtn_key_user-cap_1234567890',
      daytonaOrgId: 'org-cap-1',
      daytonaRegion: 'eu',
      allowDeleteErrored: true,
    });
    expect(blocked.snapshotStatus).toBe('failed');
    expect(calls.some((c) => c.startsWith('DELETE') || c.startsWith('POST'))).toBe(false);

    // Explicit POST /retry resets budget and deletes+recreates once.
    calls.length = 0;
    const retried = await retryUserDaytonaSnapshot('user-cap');
    expect(retried.snapshotStatus).toBe('pulling');
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(true);
    expect(calls.some((c) => c.startsWith('POST'))).toBe(true);
  });
});
