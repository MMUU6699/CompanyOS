'use client';

/**
 * Client for Kortix per-user Daytona onboarding (`/v1/onboarding/daytona/*`).
 *
 * Persists both the active WorkOS Device Flow (`flowId` + `userCode`) and the
 * short-lived `claimToken` across browser reloads / Google OAuth redirects,
 * clears both immediately after `/claim` succeeds, and sanitizes every error
 * into structured human-readable copy (never raw Daytona JSON).
 */

import { getSupabaseAccessToken } from '@/lib/auth-token';
import { getEnv } from '@/lib/env-config';

export type DaytonaSnapshotStatus = 'pending' | 'pulling' | 'active' | 'inactive' | 'failed';

export type DaytonaOnboardingErrorCode =
  | 'DAYTONA_REGION_REQUIRED'
  | 'DAYTONA_EMAIL_UNVERIFIED'
  | 'DAYTONA_QUOTA_EXCEEDED'
  | 'DAYTONA_SNAPSHOT_FAILED'
  | 'DAYTONA_RECONNECT_REQUIRED'
  | 'DAYTONA_TIMEOUT';

export interface StartDaytonaConnectResponse {
  flowId: string;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresIn: number;
  interval: number;
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
}

export interface StoredActiveFlow extends StartDaytonaConnectResponse {
  expiresAt: number;
}

export const DAYTONA_STATUS_QUERY_KEY = ['onboarding', 'daytona-status'] as const;
export const DAYTONA_RECONNECT_EVENT = 'kortix:daytona-reconnect-required';

const PENDING_FLOW_KEY = 'kortix:daytona:active-flow';
const PENDING_CLAIM_KEY = 'kortix:daytona:pending-claim';
const PENDING_MANUAL_KEY = 'kortix:daytona:pending-manual-key';
const PENDING_CLAIM_TTL_MS = 20 * 60_000;

interface StoredPendingValue {
  value: string;
  orgId?: string;
  region?: string;
  storedAt: number;
}

function onboardingBaseUrl(): string {
  const raw = (getEnv().BACKEND_URL || '/v1').replace(/\/+$/, '');
  if (raw.endsWith('/v1')) {
    return `${raw}/onboarding/daytona`;
  }
  return `${raw}/v1/onboarding/daytona`;
}

export function inferDaytonaErrorCode(
  code?: string | null,
  rawMessage?: string | null,
): DaytonaOnboardingErrorCode {
  if (
    code === 'DAYTONA_REGION_REQUIRED' ||
    code === 'DAYTONA_EMAIL_UNVERIFIED' ||
    code === 'DAYTONA_QUOTA_EXCEEDED' ||
    code === 'DAYTONA_SNAPSHOT_FAILED' ||
    code === 'DAYTONA_RECONNECT_REQUIRED' ||
    code === 'DAYTONA_TIMEOUT'
  ) {
    return code;
  }
  const lower = (rawMessage || '').toLowerCase();
  if (lower.includes('default region') || lower.includes('defaultregion')) {
    return 'DAYTONA_REGION_REQUIRED';
  }
  if (lower.includes('verify your email') || lower.includes('suspended')) {
    return 'DAYTONA_EMAIL_UNVERIFIED';
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
  // Never surface raw JSON blobs or HTTP stack frames to end users.
  if (text.includes('{') || text.includes('"statusCode"') || text.includes('/api/snapshots')) {
    return fallback;
  }
  return text;
}

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; code?: unknown };
    if (typeof body.message === 'string' && body.message.trim()) {
      return sanitizeUiErrorMessage(body.message, fallback);
    }
  } catch {
    // Non-JSON response; return clean fallback.
  }
  return fallback;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getSupabaseAccessToken();
  if (!token) {
    throw new Error('Authentication required. Please sign in again.');
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
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

export function dispatchDaytonaReconnectRequired(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DAYTONA_RECONNECT_EVENT));
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
    throw new Error(await parseErrorMessage(res, 'Could not link your Daytona workspace. Please reconnect Daytona.'));
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
    throw new Error(await parseErrorMessage(res, 'Could not check your cloud computer status. Please retry.'));
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
    throw new Error(await parseErrorMessage(res, 'Daytona rejected that API key. Check permissions and try again.'));
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

// ─── Cross-redirect Flow & Step 1 -> Step 2 Handoff Storage ──────────────────

export function stashActiveDaytonaFlow(flow: StartDaytonaConnectResponse): void {
  if (typeof window === 'undefined') return;
  try {
    const record: StoredActiveFlow = {
      ...flow,
      expiresAt: Date.now() + Math.max(flow.expiresIn || 300, 60) * 1000,
    };
    window.sessionStorage.setItem(PENDING_FLOW_KEY, JSON.stringify(record));
  } catch {}
}

export function readActiveDaytonaFlow(): StoredActiveFlow | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_FLOW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredActiveFlow>;
    if (
      typeof parsed.flowId !== 'string' ||
      typeof parsed.userCode !== 'string' ||
      typeof parsed.verificationUriComplete !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt <= Date.now() + 5_000
    ) {
      window.sessionStorage.removeItem(PENDING_FLOW_KEY);
      return null;
    }
    return parsed as StoredActiveFlow;
  } catch {
    return null;
  }
}

export function clearActiveDaytonaFlow(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(PENDING_FLOW_KEY);
  } catch {}
}

function readStoredValue(storage: Storage | null, key: string): StoredPendingValue | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPendingValue>;
    if (
      typeof parsed.value !== 'string' ||
      !parsed.value.trim() ||
      typeof parsed.storedAt !== 'number' ||
      Date.now() - parsed.storedAt > PENDING_CLAIM_TTL_MS
    ) {
      storage.removeItem(key);
      return null;
    }
    return {
      value: parsed.value,
      orgId: typeof parsed.orgId === 'string' ? parsed.orgId : undefined,
      region: typeof parsed.region === 'string' ? parsed.region : undefined,
      storedAt: parsed.storedAt,
    };
  } catch {
    return null;
  }
}

export function stashPendingDaytonaClaim(claimToken: string, meta?: { orgId?: string; region?: string }): void {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify({
    value: claimToken,
    orgId: meta?.orgId,
    region: meta?.region,
    storedAt: Date.now(),
  } satisfies StoredPendingValue);
  try {
    window.sessionStorage.setItem(PENDING_CLAIM_KEY, payload);
  } catch {}
  try {
    window.localStorage.setItem(PENDING_CLAIM_KEY, payload);
  } catch {}
}

export function readPendingDaytonaClaim(): { claimToken: string; orgId?: string; region?: string } | null {
  if (typeof window === 'undefined') return null;
  const found =
    readStoredValue(window.sessionStorage, PENDING_CLAIM_KEY) ??
    readStoredValue(window.localStorage, PENDING_CLAIM_KEY);
  if (!found) return null;
  return { claimToken: found.value, orgId: found.orgId, region: found.region };
}

export function clearPendingDaytonaClaim(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(PENDING_CLAIM_KEY);
  } catch {}
  try {
    window.localStorage.removeItem(PENDING_CLAIM_KEY);
  } catch {}
}

export function stashPendingManualDaytonaKey(apiKey: string): void {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify({
    value: apiKey.trim(),
    storedAt: Date.now(),
  } satisfies StoredPendingValue);
  try {
    window.sessionStorage.setItem(PENDING_MANUAL_KEY, payload);
  } catch {}
}

export function readPendingManualDaytonaKey(): string | null {
  if (typeof window === 'undefined') return null;
  return readStoredValue(window.sessionStorage, PENDING_MANUAL_KEY)?.value ?? null;
}

export function clearPendingManualDaytonaKey(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(PENDING_MANUAL_KEY);
  } catch {}
}

export function clearAllPendingDaytonaState(): void {
  clearActiveDaytonaFlow();
  clearPendingDaytonaClaim();
  clearPendingManualDaytonaKey();
}

export function hasPendingDaytonaOnboarding(): boolean {
  return readPendingDaytonaClaim() !== null || readPendingManualDaytonaKey() !== null;
}
