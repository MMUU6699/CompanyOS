import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  DAYTONA_CLAIM_COOKIE,
  DaytonaClaimError,
  PENDING_CLAIM_TTL_MS,
  clearAllPendingDaytonaState,
  clearPendingDaytonaClaim,
  readActiveDaytonaFlow,
  readPendingDaytonaClaim,
  stashActiveDaytonaFlow,
  stashPendingDaytonaClaim,
} from './daytona-client';

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe('Web Daytona onboarding persistence (Milestone 3c)', () => {
  const origWindow = globalThis.window;
  const origDocument = globalThis.document;
  let cookieJar = new Map<string, string>();
  let sessionStore: Storage;
  let localStore: Storage;

  beforeEach(() => {
    cookieJar = new Map<string, string>();
    sessionStore = makeMemoryStorage();
    localStore = makeMemoryStorage();

    (globalThis as { window?: unknown }).window = {
      sessionStorage: sessionStore,
      localStorage: localStore,
      location: { protocol: 'https:' },
      dispatchEvent: () => true,
    };
    (globalThis as { document?: unknown }).document = {
      get cookie() {
        return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      },
      set cookie(raw: string) {
        const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
        if (!pair) return;
        const eqIdx = pair.indexOf('=');
        if (eqIdx < 0) return;
        const name = pair.slice(0, eqIdx);
        const val = pair.slice(eqIdx + 1);
        const maxAgeAttr = attrs.find((a) => a.toLowerCase().startsWith('max-age='));
        if (maxAgeAttr && Number(maxAgeAttr.split('=')[1]) <= 0) {
          cookieJar.delete(name);
        } else {
          cookieJar.set(name, val);
        }
      },
    };
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = origWindow;
    (globalThis as { document?: unknown }).document = origDocument;
  });

  test('aligns claim TTL to 60 minutes so slow signups (>15 min) remain valid', () => {
    expect(PENDING_CLAIM_TTL_MS).toBe(60 * 60_000);
    stashPendingDaytonaClaim('claim_0000000000000000000000000000000000000000000', {
      orgId: 'org-1',
      region: 'eu',
    });
    expect(cookieJar.has(DAYTONA_CLAIM_COOKIE)).toBe(true);
    expect(readPendingDaytonaClaim()).toEqual({
      claimToken: 'claim_0000000000000000000000000000000000000000000',
      orgId: 'org-1',
      region: 'eu',
    });
  });

  test('survives browser killed & reopened (sessionStorage wiped) and OAuth redirect (cookie-only fallback)', () => {
    const token = 'claim_1111111111111111111111111111111111111111111';
    stashActiveDaytonaFlow({
      flowId: '00000000-0000-4000-8000-000000000301',
      verificationUri: 'https://verify.example.test',
      verificationUriComplete: 'https://verify.example.test?user_code=ABCD-0001',
      userCode: 'ABCD-0001',
      expiresIn: 600,
      interval: 5,
    });
    stashPendingDaytonaClaim(token, { orgId: 'org-reopen', region: 'eu' });

    // Simulate browser kill & reopen (sessionStorage cleared)
    sessionStore.clear();
    expect(readActiveDaytonaFlow()?.flowId).toBe('00000000-0000-4000-8000-000000000301');
    expect(readPendingDaytonaClaim()?.claimToken).toBe(token);

    // Simulate Google OAuth redirect into fresh storage context where only first-party cookie survived
    localStore.clear();
    expect(readPendingDaytonaClaim()).toEqual({ claimToken: token });

    // Clearing removes sessionStorage, localStorage, AND cookie
    clearAllPendingDaytonaState();
    expect(readActiveDaytonaFlow()).toBeNull();
    expect(readPendingDaytonaClaim()).toBeNull();
    expect(cookieJar.has(DAYTONA_CLAIM_COOKIE)).toBe(false);
  });

  test('two tabs share pending claim via localStorage and clearPendingDaytonaClaim cleans up both', () => {
    const tabBSession = makeMemoryStorage();
    const token = 'claim_2222222222222222222222222222222222222222222';
    stashPendingDaytonaClaim(token, { orgId: 'org-tab2', region: 'eu' });

    // Switch window.sessionStorage to Tab B (empty sessionStorage, shared localStorage)
    (globalThis.window as { sessionStorage: Storage }).sessionStorage = tabBSession;
    expect(readPendingDaytonaClaim()).toEqual({
      claimToken: token,
      orgId: 'org-tab2',
      region: 'eu',
    });

    clearPendingDaytonaClaim();
    expect(readPendingDaytonaClaim()).toBeNull();
  });

  test('DaytonaClaimError distinguishes transient (401/503/network) from terminal (400/409/410) failures', () => {
    expect(new DaytonaClaimError('auth hydrating', 401).terminal).toBe(false);
    expect(new DaytonaClaimError('offline', 0).terminal).toBe(false);
    expect(new DaytonaClaimError('gateway', 503).terminal).toBe(false);
    expect(new DaytonaClaimError('expired', 410).terminal).toBe(true);
    expect(new DaytonaClaimError('used', 409).terminal).toBe(true);
    expect(new DaytonaClaimError('bad', 400).terminal).toBe(true);
  });
});
