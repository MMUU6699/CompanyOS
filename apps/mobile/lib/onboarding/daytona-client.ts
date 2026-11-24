/**
 * Mobile client for Kortix per-user Daytona onboarding (`/v1/onboarding/daytona/*`).
 *
 * Persists BOTH the active WorkOS Device Flow (`flowId`, `userCode`,
 * `verificationUriComplete`) AND the short-lived `claimToken` in AsyncStorage
 * so Android activity restarts during Chrome Custom Tabs or OAuth handoffs
 * never lose progress, clears all temporary state immediately after `/claim`,
 * and guarantees zero raw JSON ever reaches user-facing error copy.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL, kortixGetToken } from '@/api/config';

export type DaytonaSnapshotStatus = 'pending' | 'pulling' | 'active' | 'inactive' | 'failed';

export type DaytonaOnboardingErrorCode =
  | 'DAYTONA_REGION_REQUIRED'
  | 'DAYTONA_EMAIL_UNVERIFIED'
  | 'DAYTONA_ORG_SUSPENDED'
  | 'DAYTONA_QUOTA_EXCEEDED'
  | 'DAYTONA_SNAPSHOT_BUILDING'
  | 'DAYTONA_SNAPSHOT_FAILED'
  | 'DAYTONA_SNAPSHOT_CONFIG_INVALID'
  | 'DAYTONA_RECONNECT_REQUIRED'
  | 'DAYTONA_NOT_CONNECTED'
  | 'DAYTONA_TIMEOUT'
  | 'DAYTONA_TOO_MANY_FLOWS'
  | 'DAYTONA_RATE_LIMITED';

export interface StartDaytonaConnectResponse {
  flowId: string;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

export interface StoredActiveFlow extends StartDaytonaConnectResponse {
  expiresAt: number;
}

export type PollDaytonaConnectResponse =
  | { status: 'pending'; slowDown?: boolean }
  | { status: 'expired' }
  | { status: 'email_verification_required'; errorCode?: DaytonaOnboardingErrorCode; message: string }
  | { status: 'approved'; claimToken: string; orgId: string; region: string }
  | { status: 'claimed'; orgId: string | null; region: string | null };

export interface DaytonaOnboardingStatus {
  connected: boolean;
  orgId: string | null;
  region: string | null;
  snapshotName: string | null;
  snapshotStatus: DaytonaSnapshotStatus | null;
  snapshotErrorCode?: DaytonaOnboardingErrorCode | null;
  snapshotError: string | null;
  reconnectRequired?: boolean;
  previousOrgId?: string | null;
  orgSwitched?: boolean;
  warning?: string | null;
}

export const DAYTONA_STATUS_QUERY_KEY = ['onboarding', 'daytona-status'] as const;

const ACTIVE_FLOW_STORAGE_KEY = 'kortix:daytona:active-flow';
const PENDING_CLAIM_STORAGE_KEY = 'kortix:daytona:pending-claim';
const PENDING_CLAIM_TTL_MS = 20 * 60_000;

// In-memory only for a pre-auth manual API key (never written to disk plaintext).
let pendingManualApiKeyMemory: { value: string; storedAt: number } | null = null;

type ReconnectListener = () => void;
const reconnectListeners = new Set<ReconnectListener>();

export function subscribeDaytonaReconnect(listener: ReconnectListener): () => void {
  reconnectListeners.add(listener);
  return () => {
    reconnectListeners.delete(listener);
  };
}

export function notifyDaytonaReconnectRequired(): void {
  for (const listener of reconnectListeners) {
    try {
      listener();
    } catch {
      // Listener errors must never break SDK error handling.
    }
  }
}

export function inferDaytonaErrorCode(
  code?: string | null,
  rawMessage?: string | null,
): DaytonaOnboardingErrorCode {
  if (
    code === 'DAYTONA_REGION_REQUIRED' ||
    code === 'DAYTONA_EMAIL_UNVERIFIED' ||
    code === 'DAYTONA_ORG_SUSPENDED' ||
    code === 'DAYTONA_QUOTA_EXCEEDED' ||
    code === 'DAYTONA_SNAPSHOT_BUILDING' ||
    code === 'DAYTONA_SNAPSHOT_FAILED' ||
    code === 'DAYTONA_SNAPSHOT_CONFIG_INVALID' ||
    code === 'DAYTONA_RECONNECT_REQUIRED' ||
    code === 'DAYTONA_NOT_CONNECTED' ||
    code === 'DAYTONA_TIMEOUT' ||
    code === 'DAYTONA_TOO_MANY_FLOWS' ||
    code === 'DAYTONA_RATE_LIMITED'
  ) {
    return code;
  }
  const lower = (rawMessage || '').toLowerCase();
  if (lower.includes('default region') || lower.includes('defaultregion')) {
    return 'DAYTONA_REGION_REQUIRED';
  }
  if (lower.includes('verify your email') || lower.includes('email_access_denied')) {
    return 'DAYTONA_EMAIL_UNVERIFIED';
  }
  if (lower.includes('depleted credits') || lower.includes('suspended')) {
    return 'DAYTONA_ORG_SUSPENDED';
  }
  if (
    lower.includes('reconnect') ||
    lower.includes('unauthorized') ||
    lower.includes('revoked') ||
    lower.includes('invalid api key')
  ) {
    return 'DAYTONA_RECONNECT_REQUIRED';
  }
  if (lower.includes('quota') || lower.includes('limit exceeded')) {
    return 'DAYTONA_QUOTA_EXCEEDED';
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('network')) {
    return 'DAYTONA_TIMEOUT';
  }
  return 'DAYTONA_SNAPSHOT_FAILED';
}

export function sanitizeUiErrorMessage(
  rawMessage: string | null | undefined,
  fallback: string,
): string {
  const text = (rawMessage || '').trim();
  if (!text) return fallback;
  if (text.includes('{') || text.includes('"statusCode"') || text.includes('/api/snapshots')) {
    return fallback;
  }
  return text;
}

export function isDaytonaReconnectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    error?: unknown;
    reconnectRequired?: unknown;
    details?: { code?: unknown; error?: unknown };
  };
  return (
    candidate.status === 428 ||
    candidate.reconnectRequired === true ||
    candidate.code === 'daytona_reconnect_required' ||
    candidate.code === 'DAYTONA_RECONNECT_REQUIRED' ||
    candidate.code === 'DAYTONA_REGION_REQUIRED' ||
    candidate.error === 'daytona_reconnect_required' ||
    candidate.details?.code === 'daytona_reconnect_required' ||
    candidate.details?.code === 'DAYTONA_RECONNECT_REQUIRED' ||
    candidate.details?.error === 'daytona_reconnect_required'
  );
}

function onboardingBaseUrl(): string {
  const raw = API_URL.replace(/\/+$/, '');
  if (raw.endsWith('/v1')) {
    return `${raw}/onboarding/daytona`;
  }
  return `${raw}/v1/onboarding/daytona`;
}

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.trim()) {
      return sanitizeUiErrorMessage(body.message, fallback);
    }
  } catch {
    // Non-JSON response.
  }
  return fallback;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await kortixGetToken();
  if (!token) {
    throw new Error('Authentication required. Please sign in again.');
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

export async function startDaytonaConnect(): Promise<StartDaytonaConnectResponse> {
  const res = await fetch(`${onboardingBaseUrl()}/start`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, 'Could not start Daytona sign-in. Please try again.'));
  }
  return (await res.json()) as StartDaytonaConnectResponse;
}

export async function pollDaytonaConnect(flowId: string): Promise<PollDaytonaConnectResponse> {
  const res = await fetch(`${onboardingBaseUrl()}/poll`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ flowId }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, 'Could not verify Daytona approval. Please try again.'));
  }
  return (await res.json()) as PollDaytonaConnectResponse;
}

export async function claimDaytonaConnect(claimToken: string): Promise<DaytonaOnboardingStatus> {
  const headers = await authHeaders();
  const res = await fetch(`${onboardingBaseUrl()}/claim`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ claimToken }),
  });
  if (!res.ok) {
    throw new Error(
      await parseErrorMessage(res, 'Could not link your Daytona workspace. Please reconnect Daytona.'),
    );
  }
  return (await res.json()) as DaytonaOnboardingStatus;
}

export async function fetchDaytonaOnboardingStatus(): Promise<DaytonaOnboardingStatus> {
  const headers = await authHeaders();
  const res = await fetch(`${onboardingBaseUrl()}/status`, {
    method: 'GET',
    headers,
  });
  if (!res.ok) {
    throw new Error(
      await parseErrorMessage(res, 'Could not check your cloud computer status. Please retry.'),
    );
  }
  return (await res.json()) as DaytonaOnboardingStatus;
}

export async function retryDaytonaSnapshot(): Promise<DaytonaOnboardingStatus> {
  const headers = await authHeaders();
  const res = await fetch(`${onboardingBaseUrl()}/retry`, {
    method: 'POST',
    headers,
  });
  if (!res.ok) {
    throw new Error(
      await parseErrorMessage(res, 'Could not retry cloud computer image setup. Please try again.'),
    );
  }
  return (await res.json()) as DaytonaOnboardingStatus;
}

export async function saveManualDaytonaKey(
  apiKey: string,
  region?: string,
): Promise<DaytonaOnboardingStatus> {
  const headers = await authHeaders();
  const res = await fetch(`${onboardingBaseUrl()}/manual-key`, {
    method: 'POST',
    headers,
    body: JSON.stringify(region ? { apiKey, region } : { apiKey }),
  });
  if (!res.ok) {
    throw new Error(
      await parseErrorMessage(res, 'Daytona rejected that API key. Check permissions and try again.'),
    );
  }
  return (await res.json()) as DaytonaOnboardingStatus;
}

export async function disconnectDaytona(): Promise<void> {
  const headers = await authHeaders();
  const res = await fetch(`${onboardingBaseUrl()}/disconnect`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, 'Could not disconnect Daytona.'));
  }
}

// ─── Activity-restart & Step 1 -> Step 2 Handoff Storage ─────────────────────

export async function stashActiveDaytonaFlow(flow: StartDaytonaConnectResponse): Promise<void> {
  try {
    const record: StoredActiveFlow = {
      ...flow,
      expiresAt: Date.now() + Math.max(flow.expiresIn || 300, 60) * 1000,
    };
    await AsyncStorage.setItem(ACTIVE_FLOW_STORAGE_KEY, JSON.stringify(record));
  } catch {}
}

export async function readActiveDaytonaFlow(): Promise<StoredActiveFlow | null> {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_FLOW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredActiveFlow>;
    if (
      typeof parsed.flowId !== 'string' ||
      typeof parsed.userCode !== 'string' ||
      typeof parsed.verificationUriComplete !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt <= Date.now() + 5_000
    ) {
      await AsyncStorage.removeItem(ACTIVE_FLOW_STORAGE_KEY);
      return null;
    }
    return parsed as StoredActiveFlow;
  } catch {
    return null;
  }
}

export async function clearActiveDaytonaFlow(): Promise<void> {
  try {
    await AsyncStorage.removeItem(ACTIVE_FLOW_STORAGE_KEY);
  } catch {}
}

export async function stashPendingDaytonaClaim(
  claimToken: string,
  meta?: { orgId?: string; region?: string },
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      PENDING_CLAIM_STORAGE_KEY,
      JSON.stringify({
        claimToken,
        orgId: meta?.orgId,
        region: meta?.region,
        storedAt: Date.now(),
      }),
    );
  } catch {}
}

export async function readPendingDaytonaClaim(): Promise<{
  claimToken: string;
  orgId?: string;
  region?: string;
} | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_CLAIM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      claimToken?: unknown;
      orgId?: unknown;
      region?: unknown;
      storedAt?: unknown;
    };
    if (
      typeof parsed.claimToken !== 'string' ||
      !parsed.claimToken.trim() ||
      typeof parsed.storedAt !== 'number' ||
      Date.now() - parsed.storedAt > PENDING_CLAIM_TTL_MS
    ) {
      await AsyncStorage.removeItem(PENDING_CLAIM_STORAGE_KEY);
      return null;
    }
    return {
      claimToken: parsed.claimToken,
      orgId: typeof parsed.orgId === 'string' ? parsed.orgId : undefined,
      region: typeof parsed.region === 'string' ? parsed.region : undefined,
    };
  } catch {
    return null;
  }
}

export async function clearPendingDaytonaClaim(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_CLAIM_STORAGE_KEY);
  } catch {}
}

export function stashPendingManualDaytonaKey(apiKey: string): void {
  pendingManualApiKeyMemory = {
    value: apiKey.trim(),
    storedAt: Date.now(),
  };
}

export function readPendingManualDaytonaKey(): string | null {
  if (!pendingManualApiKeyMemory) return null;
  if (Date.now() - pendingManualApiKeyMemory.storedAt > PENDING_CLAIM_TTL_MS) {
    pendingManualApiKeyMemory = null;
    return null;
  }
  return pendingManualApiKeyMemory.value;
}

export function clearPendingManualDaytonaKey(): void {
  pendingManualApiKeyMemory = null;
}

export async function clearAllPendingDaytonaState(): Promise<void> {
  clearPendingManualDaytonaKey();
  await Promise.all([clearActiveDaytonaFlow(), clearPendingDaytonaClaim()]);
}

export async function hasPendingDaytonaOnboarding(): Promise<boolean> {
  if (readPendingManualDaytonaKey()) return true;
  return (await readPendingDaytonaClaim()) !== null;
}
