import { describe, expect, test } from 'bun:test';
import { deriveCloudComputerView, getCloudComputerCopy } from './cloud-computer-view';

describe('deriveCloudComputerView', () => {
  test('handles offline, loading, and fetch error states cleanly', () => {
    const offline = deriveCloudComputerView({ isLoading: false, isOffline: true });
    expect(offline.state).toBe('offline');
    expect(offline.showConnectFlowByDefault).toBe(false);

    const loading = deriveCloudComputerView({ isLoading: true, isOffline: false });
    expect(loading.state).toBe('loading');
    expect(loading.rowBadge).toBe('Checking…');

    const errored = deriveCloudComputerView({
      isLoading: false,
      isOffline: false,
      errorMessage: 'Gateway timeout',
    });
    expect(errored.state).toBe('error');
    expect(errored.subtitle).toBe('Gateway timeout');
  });

  test('routes not_connected and reconnect_required directly to the connect flow', () => {
    const disconnected = deriveCloudComputerView({
      isLoading: false,
      isOffline: false,
      status: {
        connected: false,
        orgId: null,
        region: null,
        snapshotName: null,
        snapshotStatus: null,
        snapshotError: null,
      },
    });
    expect(disconnected.state).toBe('not_connected');
    expect(disconnected.showConnectFlowByDefault).toBe(true);
    expect(disconnected.canDisconnect).toBe(false);

    const reconnect = deriveCloudComputerView({
      isLoading: false,
      isOffline: false,
      status: {
        connected: true,
        reconnectRequired: true,
        orgId: 'af2b628f-0000-4000-8000-000000000001',
        region: 'eu',
        snapshotName: 'kortix-sandbox',
        snapshotStatus: 'active',
        snapshotError: 'API key revoked',
      },
    });
    expect(reconnect.state).toBe('reconnect_required');
    expect(reconnect.showConnectFlowByDefault).toBe(true);
    expect(reconnect.canDisconnect).toBe(true);
  });

  test('surfaces healthy, provisioning, degraded snapshot retry, org-switch warning, and Arabic RTL', () => {
    const healthy = deriveCloudComputerView({
      isLoading: false,
      isOffline: false,
      status: {
        connected: true,
        orgId: 'af2b628f-0000-4000-8000-000000000001',
        region: 'eu',
        snapshotName: 'kortix-sandbox-v1',
        snapshotStatus: 'active',
        snapshotError: null,
        orgSwitched: true,
        previousOrgId: '11112222-3333-4444-5555-666677778888',
      },
    });
    expect(healthy.state).toBe('connected_healthy');
    expect(healthy.orgLabel).toBe('af2b628f…0001');
    expect(healthy.regionLabel).toBe('EU');
    expect(healthy.snapshotBadge).toBe('Ready');
    expect(healthy.orgSwitchNotice).toContain('11112222…8888');
    expect(healthy.showConnectFlowByDefault).toBe(false);

    const degradedAr = deriveCloudComputerView({
      isLoading: false,
      isOffline: false,
      locale: 'ar',
      status: {
        connected: true,
        orgId: '2fcbe92b-0000-4000-8000-000000000002',
        region: 'eu',
        snapshotName: 'kortix-sandbox-v1',
        snapshotStatus: 'failed',
        snapshotError: 'Organization is suspended',
      },
    });
    expect(degradedAr.state).toBe('connected_degraded');
    expect(degradedAr.isRtl).toBe(true);
    expect(degradedAr.canRetrySnapshot).toBe(true);
    expect(getCloudComputerCopy('ar').isRtl).toBe(true);
  });
});
