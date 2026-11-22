import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  classifyDaytonaError,
  ensureDefaultRegionOnOrg,
  ensureUserSnapshot,
  fetchOrganizationsWithPropagationRetry,
  mintPermanentDaytonaKey,
  resolvePreferredSharedRegion,
  sanitizeStoredDaytonaError,
} from './daytona-service';
import { ensureDaytonaCapacitySlot } from '../projects/compute-quota-guard';
import {
  classifySandboxProvisioningFailure,
  DAYTONA_DEPLETED_CREDITS_MESSAGE,
} from '../platform/services/sandbox-provisioning-error';
import { isSnapshotStillBuilding } from '../platform/services/sandbox-init-state';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('daytona onboarding error classification & sanitization', () => {
  it('maps Daytona 400 DefaultRegionRequiredException JSON to DAYTONA_REGION_REQUIRED without leaking raw JSON', () => {
    const rawJson =
      '{"path":"/api/snapshots","timestamp":"2026-11-21T20:01:22.723Z","statusCode":400,"error":"Bad Request","message":"This organization does not have a default region. Please open the Daytona Dashboard to set a default region."}';
    const result = classifyDaytonaError(400, rawJson);
    assert.equal(result.code, 'DAYTONA_REGION_REQUIRED');
    assert.equal(result.reconnectRequired, true);
    assert.equal(result.message.includes('{'), false);
    assert.equal(result.message.includes('/api/snapshots'), false);
  });

  it('sanitizes legacy raw JSON stored in snapshot_error column', () => {
    const legacyRow =
      'Daytona snapshot create failed (HTTP 400): {"path":"/api/snapshots","statusCode":400,"message":"This organization does not have a default region."}';
    const sanitized = sanitizeStoredDaytonaError(legacyRow);
    assert.ok(sanitized);
    assert.equal(sanitized.code, 'DAYTONA_REGION_REQUIRED');
    assert.equal(sanitized.reconnectRequired, true);
    assert.equal(sanitized.message.includes('{'), false);
  });

  it('maps 401/403 revoked keys to DAYTONA_RECONNECT_REQUIRED', () => {
    const result = classifyDaytonaError(401, '{"message":"Unauthorized"}');
    assert.equal(result.code, 'DAYTONA_RECONNECT_REQUIRED');
    assert.equal(result.reconnectRequired, true);
  });

  it('maps suspended orgs to DAYTONA_EMAIL_UNVERIFIED', () => {
    const result = classifyDaytonaError(403, 'Organization is suspended: verify your email');
    assert.equal(result.code, 'DAYTONA_EMAIL_UNVERIFIED');
    assert.equal(result.reconnectRequired, false);
  });

  it('maps quota limits and timeouts cleanly', () => {
    assert.equal(classifyDaytonaError(402, 'Total disk quota exceeded').code, 'DAYTONA_QUOTA_EXCEEDED');
    assert.equal(classifyDaytonaError(504, 'Gateway timed out').code, 'DAYTONA_TIMEOUT');
  });
});

describe('daytona onboarding region, org propagation & key collision handling', () => {
  it('resolves shared region via GET /shared-regions and patches defaultRegionId via PATCH', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.endsWith('/shared-regions')) {
        return new Response(JSON.stringify([{ id: 'us', name: 'us' }, { id: 'eu', name: 'eu' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/organizations/org-123/default-region') && method === 'PATCH') {
        return new Response(JSON.stringify({ id: 'org-123', defaultRegionId: 'eu' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;

    const preferred = await resolvePreferredSharedRegion('eu');
    assert.equal(preferred, 'eu');

    const resolved = await ensureDefaultRegionOnOrg('jwt-test', 'org-123', null);
    assert.equal(resolved, 'eu');

    const patchCall = calls.find((c) => c.method === 'PATCH');
    assert.ok(patchCall, 'expected PATCH /organizations/org-123/default-region');
    assert.equal(patchCall.body, JSON.stringify({ defaultRegionId: 'eu' }));
  });

  it('retries empty GET /organizations responses until personal org propagates', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts < 3) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(
        JSON.stringify([{ id: 'org-new', personal: true, suspended: false, defaultRegionId: null }]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const orgs = await fetchOrganizationsWithPropagationRetry('jwt-new', 5, 1);
    assert.equal(attempts, 3);
    assert.equal(orgs.length, 1);
    assert.equal(orgs[0]?.id, 'org-new');
  });

  it('prunes stale kortix-app-* keys and retries 409 name collision when minting key', async () => {
    const deleted: string[] = [];
    let postAttempts = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method || 'GET').toUpperCase();
      if (url.endsWith('/api-keys') && method === 'GET') {
        return new Response(
          JSON.stringify([
            { name: 'kortix-app-3', createdAt: '2026-11-21T03:00:00Z' },
            { name: 'kortix-app-2', createdAt: '2026-11-21T02:00:00Z' },
            { name: 'kortix-app-1', createdAt: '2026-11-21T01:00:00Z' },
            { name: 'other-user-key', createdAt: '2026-11-20T01:00:00Z' },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('/api-keys/') && method === 'DELETE') {
        deleted.push(url.split('/api-keys/')[1] || '');
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/api-keys') && method === 'POST') {
        postAttempts++;
        if (postAttempts === 1) {
          return new Response(JSON.stringify({ message: 'API key already exists' }), { status: 409 });
        }
        return new Response(JSON.stringify({ value: 'dtn_' + 'unit_test_fixture_value' }), {
          status: 201,
        });
      }
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;

    const minted = await mintPermanentDaytonaKey('jwt-test', 'org-123', 'flow-uuid-1234');
    assert.equal(minted, 'dtn_' + 'unit_test_fixture_value');
    assert.deepEqual(deleted, ['kortix-app-1']);
    assert.equal(postAttempts, 2);
  });

  it('treats POST /snapshots HTTP timeout as pulling rather than falsely failing', async () => {
    const prevImage = process.env.KORTIX_SANDBOX_GHCR_IMAGE;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET' && url.includes('/snapshots/')) {
        return new Response('Not Found', { status: 404 });
      }
      if (method === 'POST' && url.endsWith('/snapshots')) {
        const timeoutErr = new Error('The operation was aborted due to timeout');
        timeoutErr.name = 'TimeoutError';
        throw timeoutErr;
      }
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;

    try {
      const res = await ensureUserSnapshot({
        apiKey: 'dtn_' + 'unit_test_timeout_key',
        daytonaOrgId: 'org-timeout-check',
        daytonaRegion: 'eu',
      });
      // When KORTIX_SANDBOX_GHCR_IMAGE is configured in env, timeout stays in 'pulling'.
      if (prevImage) {
        assert.equal(res.snapshotStatus, 'pulling');
        assert.equal(res.snapshotErrorCode, null);
      } else {
        assert.equal(res.snapshotStatus, 'failed');
      }
    } finally {
      if (prevImage === undefined) delete process.env.KORTIX_SANDBOX_GHCR_IMAGE;
      else process.env.KORTIX_SANDBOX_GHCR_IMAGE = prevImage;
    }
  });

  it('skips listStopped and disk archival when skipDiskEviction is true (warm stopped resume)', async () => {
    let listStartedCalls = 0;
    let listStoppedCalls = 0;
    const archived: string[] = [];
    const stopped: string[] = [];

    await ensureDaytonaCapacitySlot(
      'resume:warm-target',
      {
        listStarted: async () => {
          listStartedCalls++;
          return [
            {
              id: 'sb-running-1',
              cpu: 2,
              memory: 4,
              createdAt: '2026-11-22T00:00:00Z',
              lastActivityAt: '2026-11-22T01:00:00Z',
              managed: true,
            },
          ];
        },
        listStopped: async () => {
          listStoppedCalls++;
          return [
            { id: 'sb-stopped-1', disk: 10, lastActivityAt: '2026-11-22T00:00:00Z', managed: true },
            { id: 'sb-stopped-2', disk: 10, lastActivityAt: '2026-11-22T00:30:00Z', managed: true },
          ];
        },
        stop: async (id) => {
          stopped.push(id);
          return true;
        },
        archive: async (id) => {
          archived.push(id);
          return true;
        },
        getState: async () => 'stopped',
      },
      { maxRunning: 2, maxNonArchived: 3, skipDiskEviction: true },
      'warm-target',
      'org-warm-test',
    );

    assert.equal(listStartedCalls, 1);
    assert.equal(listStoppedCalls, 0);
    assert.deepEqual(stopped, []);
    assert.deepEqual(archived, []);
  });

  it('classifies Daytona depleted credits suspension cleanly (not generic error or email unverified)', () => {
    const onboarding = classifyDaytonaError(403, 'Organization is suspended: Depleted credits');
    assert.equal(onboarding.code, 'DAYTONA_QUOTA_EXCEEDED');
    assert.equal(onboarding.reconnectRequired, false);

    const provisioning = classifySandboxProvisioningFailure(
      new Error('Organization is suspended: Depleted credits'),
    );
    assert.equal(provisioning.category, 'sandbox-provider');
    assert.equal(provisioning.transient, false);
    assert.equal(provisioning.userMessage, DAYTONA_DEPLETED_CREDITS_MESSAGE);

    const pullingErr = Object.assign(
      new Error('Snapshot kortix-sandbox-v1 is pulling'),
      { name: 'DaytonaError' },
    );
    assert.equal(isSnapshotStillBuilding(pullingErr), true);

    const emailDenied = classifyDaytonaError(
      403,
      '{"statusCode":403,"error":"Forbidden","message":"Please use your primary or work email address.","code":"EMAIL_ACCESS_DENIED"}',
    );
    assert.equal(emailDenied.code, 'DAYTONA_EMAIL_UNVERIFIED');
    assert.equal(emailDenied.reconnectRequired, false);
    assert.equal(emailDenied.message.includes('primary or work email'), true);
    assert.equal(emailDenied.message.includes('{'), false);
  });
});
