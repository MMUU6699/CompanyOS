/**
 * Phase 1 unit tests for the canonical discriminated Daytona context resolvers
 * in onboarding/daytona-service.ts.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const mockConfig = {
  DAYTONA_API_KEY: '',
  KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK: false,
  DAYTONA_SERVER_URL: 'https://daytona.example.test/api',
  DAYTONA_TARGET: 'eu',
  API_KEY_SECRET: '00000000000000000000000000000000',
  DAYTONA_CREDENTIALS_ENCRYPTION_KEY: '00000000000000000000000000000000',
};

const warnLogs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];

mock.module('../config', () => ({ config: mockConfig }));
mock.module('../lib/logger', () => ({
  logger: {
    info: () => {},
    warn: (msg: string, meta?: Record<string, unknown>) => warnLogs.push({ msg, meta }),
    error: () => {},
    debug: () => {},
  },
}));

type QueryResponder = () => Promise<unknown[]>;
let dbResponders: QueryResponder[] = [];

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => {
          const next = dbResponders.shift();
          if (!next) return Promise.resolve([]);
          return next();
        },
      }),
    }),
  }),
};

mock.module('../shared/db', () => ({ db: fakeDb, hasDatabase: true }));

const { encryptDaytonaApiKey } = await import('./daytona-crypto');
const {
  invalidateUserDaytonaCache,
  resolveDaytonaContextForExternalId,
  resolveDaytonaContextForOwner,
  resolveUserDaytonaContext,
} = await import('./daytona-service');

function makeEncryptedCredRow(userId: string, orgId: string, apiKey = 'dtn_user_valid_key_123456') {
  const enc = encryptDaytonaApiKey(userId, apiKey);
  return {
    userId,
    encryptedApiKey: enc.encryptedApiKey,
    encryptionIv: enc.encryptionIv,
    encryptionTag: enc.encryptionTag,
    daytonaOrgId: orgId,
    daytonaRegion: 'eu',
    snapshotName: 'kortix-sandbox-test',
    snapshotStatus: 'active' as const,
  };
}

beforeEach(() => {
  mockConfig.KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK = false;
  dbResponders = [];
  warnLogs.length = 0;
  invalidateUserDaytonaCache('user-a');
  invalidateUserDaytonaCache('user-b');
  invalidateUserDaytonaCache('owner-1');
});

describe('canonical Daytona context resolvers (Phase 1)', () => {
  test('resolveUserDaytonaContext returns { kind: "error" } on DB failure (never not_connected)', async () => {
    dbResponders.push(async () => {
      throw new Error('PG pool exhausted');
    });
    const res = await resolveUserDaytonaContext('user-a');
    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.message).toContain('PG pool exhausted');
    }
  });

  test('resolveUserDaytonaContext returns { kind: "reconnect_required" } on undecryptable key', async () => {
    dbResponders.push(async () => [
      {
        userId: 'user-a',
        encryptedApiKey: 'corrupted-ciphertext',
        encryptionIv: 'bad-iv',
        encryptionTag: 'bad-tag',
        daytonaOrgId: 'org-a',
        daytonaRegion: 'eu',
        snapshotName: null,
        snapshotStatus: 'active',
      },
    ]);
    const res = await resolveUserDaytonaContext('user-a');
    expect(res.kind).toBe('reconnect_required');
  });

  test('resolveDaytonaContextForOwner does NOT fall back to account owner by default', async () => {
    // user-b has no credentials
    dbResponders.push(async () => []);
    const res = await resolveDaytonaContextForOwner({
      userId: 'user-b',
      accountId: 'acct-1',
      sessionId: 'sess-trigger-1',
    });
    expect(res.kind).toBe('not_connected');
    expect(warnLogs.length).toBe(0);
  });

  test('resolveDaytonaContextForOwner falls back to account owner ONLY when KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK=true and logs WARN with sessionId', async () => {
    mockConfig.KORTIX_ALLOW_PLATFORM_DAYTONA_FALLBACK = true;
    // 1. user-b lookup -> not found
    dbResponders.push(async () => []);
    // 2. account_members owner lookup -> owner-1
    dbResponders.push(async () => [{ userId: 'owner-1' }]);
    // 3. owner-1 credentials lookup -> found
    dbResponders.push(async () => [makeEncryptedCredRow('owner-1', 'org-owner')]);

    const res = await resolveDaytonaContextForOwner({
      userId: 'user-b',
      accountId: 'acct-1',
      sessionId: 'sess-trigger-2',
    });
    expect(res.kind).toBe('user');
    if (res.kind === 'user') {
      expect(res.ctx.userId).toBe('owner-1');
    }
    expect(warnLogs.some((w) => w.meta?.sessionId === 'sess-trigger-2')).toBe(true);
  });

  test('resolveDaytonaContextForExternalId returns reconnect_required on org mismatch instead of falling back', async () => {
    // 1. session_sandboxes lookup -> owned by user-a in org-OLD
    dbResponders.push(async () => [
      {
        sandboxId: 'sess-old',
        accountId: 'acct-1',
        metadata: { daytonaOwnerUserId: 'user-a', daytonaOrgId: 'org-OLD' },
      },
    ]);
    // 2. user-a credentials lookup -> now connected to org-NEW
    dbResponders.push(async () => [makeEncryptedCredRow('user-a', 'org-NEW')]);

    const res = await resolveDaytonaContextForExternalId('ext-old-org');
    expect(res.kind).toBe('reconnect_required');
  });

  test('resolveDaytonaContextForExternalId propagates DB error as { kind: "error" }', async () => {
    dbResponders.push(async () => {
      throw new Error('DB read timeout');
    });
    const res = await resolveDaytonaContextForExternalId('ext-db-err');
    expect(res.kind).toBe('error');
  });
});
