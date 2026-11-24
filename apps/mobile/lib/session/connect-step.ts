/**
 * The next step of the session-open loop (`ProjectScreen.ensureAndOpen`),
 * decided from one `POST /start` answer. Pure, with no React Native imports,
 * so `bun test` can run it.
 *
 * Same rules as `@kortix/sdk`'s `shouldPollSessionStart` and
 * `shouldRetrySessionStart` on web: a terminal stage or a client error stops
 * at once; a transient failure polls again, up to
 * `MAX_START_REQUEST_FAILURES` in a row, then stops with ONE visible error.
 */
import type { SessionStartResult } from '@kortix/sdk';

export type ConnectFailureActionKind = 'reconnect' | 'billing' | 'retry';

/** Structurally `SessionConnectError` (components/session/SessionConnecting). */
export interface ConnectFailure {
  title: string;
  message: string;
  /** Raw error text, shown verbatim under the message. */
  detail?: string;
  /** The provider removed the box: the action continues the session on a new computer (`recover`), not a restart. */
  lost?: boolean;
  /** Typed machine-readable error code when known (e.g. DAYTONA_ORG_SUSPENDED). */
  code?: string;
  /** Primary remediation action for typed provider/onboarding errors. */
  actionKind?: ConnectFailureActionKind;
}

export type ConnectStep =
  /** Not ready yet: wait, then call `/start` again. */
  | { kind: 'poll' }
  /** The sandbox is active: probe its health and open the chat when ready. */
  | { kind: 'open' }
  /** Stop the loop and show this failure. */
  | { kind: 'fail'; failure: ConnectFailure };

const LOST_TITLE = "This session's computer was lost";
const LOST_MESSAGE =
  'Its cloud sandbox disappeared on the provider side. Continue the session on a new computer: it starts from the session branch and brings this conversation back. Work that was not committed and pushed stays lost.';

/** Failed `/start` requests in a row before the loop gives up. */
export const MAX_START_REQUEST_FAILURES = 3;

type StartAnswer = Pick<SessionStartResult, 'stage' | 'retriable' | 'failure' | 'reason' | 'code' | 'message'> & {
  sandbox: { status: string; external_id: string | null } | null;
};

function daytonaFailurePresentation(
  code: string | undefined,
  fallbackMessage: string,
): ConnectFailure | null {
  switch (code) {
    case 'DAYTONA_ORG_SUSPENDED':
      return {
        title: 'Daytona workspace suspended',
        message: fallbackMessage,
        code,
        actionKind: 'billing',
      };
    case 'DAYTONA_RECONNECT_REQUIRED':
      return {
        title: 'Reconnect Daytona',
        message: fallbackMessage,
        code,
        actionKind: 'reconnect',
      };
    case 'DAYTONA_NOT_CONNECTED':
      return {
        title: 'Connect Daytona',
        message: fallbackMessage,
        code,
        actionKind: 'reconnect',
      };
    case 'DAYTONA_REGION_REQUIRED':
      return {
        title: 'Daytona region required',
        message: fallbackMessage,
        code,
        actionKind: 'reconnect',
      };
    case 'DAYTONA_EMAIL_UNVERIFIED':
      return {
        title: 'Verify your Daytona email',
        message: fallbackMessage,
        code,
        actionKind: 'billing',
      };
    case 'DAYTONA_SNAPSHOT_FAILED':
    case 'DAYTONA_SNAPSHOT_CONFIG_INVALID':
      return {
        title: 'Cloud computer image unavailable',
        message: fallbackMessage,
        code,
        actionKind: 'retry',
      };
    default:
      return null;
  }
}

export function connectStepFromStart(start: StartAnswer): ConnectStep {
  // The provider removed the box and no in-place recovery answered (KRTX-2419).
  if (start.reason === 'runtime_identity_unavailable') {
    return { kind: 'fail', failure: { title: LOST_TITLE, message: LOST_MESSAGE, lost: true } };
  }
  const code = start.code ?? start.failure?.code;
  const serverMessage = start.message ?? start.failure?.message;
  if (start.stage === 'error' || start.stage === 'failed' || start.sandbox?.status === 'error') {
    const daytonaFailure = daytonaFailurePresentation(
      code,
      serverMessage ?? 'The sandbox could not be started.',
    );
    if (daytonaFailure) {
      return { kind: 'fail', failure: daytonaFailure };
    }
    return fail(
      'Session failed to start',
      serverMessage ?? 'The sandbox could not be provisioned.',
    );
  }
  // Require `stage === 'ready'` before opening the thread: while `stage` is still
  // `'starting'` / `'booting'` / `'provisioning'`, keep polling `/start` (with server-side
  // `waitMs`) rather than stalling inside a 15 s blocking `getSessionHealth` probe on a
  // waking sandbox whose DB row still carries a stale `status: 'active'`.
  if (start.stage === 'ready' && start.sandbox?.status === 'active' && start.sandbox.external_id) {
    return { kind: 'open' };
  }
  if (start.stage === 'stopped' || start.retriable === false) {
    const daytonaFailure = daytonaFailurePresentation(
      code,
      serverMessage ?? 'The session runtime stopped. Restart it to continue.',
    );
    if (daytonaFailure) {
      return { kind: 'fail', failure: daytonaFailure };
    }
    return fail(
      'Session is not running',
      serverMessage ?? 'The session runtime stopped. Restart it to continue.',
    );
  }
  return { kind: 'poll' };
}

/**
 * `consecutiveFailures` counts this failure: 1 on the first failed request.
 */
export function connectStepFromRequestError(
  error: unknown,
  consecutiveFailures: number,
): ConnectStep {
  const status = statusOf(error);
  const code = codeOf(error);
  const terminal = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
  if (!terminal && consecutiveFailures < MAX_START_REQUEST_FAILURES) return { kind: 'poll' };

  const message = error instanceof Error && error.message ? error.message : null;
  const daytonaFailure = daytonaFailurePresentation(
    code,
    message ?? 'Your Daytona connection needs attention before starting this session.',
  );
  if (daytonaFailure) {
    return { kind: 'fail', failure: daytonaFailure };
  }
  // No HTTP status: the request never reached the API (DNS, refused, offline).
  if (status === null) {
    return fail(
      'Could not reach the server',
      'The app could not connect to the Kortix API. Check the connection and try again.',
      message ?? undefined,
    );
  }
  return fail('Could not start session', message ?? `Request failed (${status})`);
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

function codeOf(error: unknown): string | undefined {
  const obj = error as { code?: unknown; details?: { code?: unknown } } | null | undefined;
  if (typeof obj?.code === 'string' && obj.code.length > 0) return obj.code;
  if (typeof obj?.details?.code === 'string' && obj.details.code.length > 0) return obj.details.code;
  return undefined;
}

function fail(title: string, message: string, detail?: string): ConnectStep {
  return { kind: 'fail', failure: detail ? { title, message, detail } : { title, message } };
}

/**
 * The wait before `/start` poll `attempt + 1` while the runtime is not ready
 * (COR-185): 300 ms after the first answer, 700 ms after the second, then
 * 1.5 s. A warm or fast box is usually ready on the 2nd or 3rd answer, so a
 * flat 1.5 s wait cost up to ~2 s before the thread opened. A failed request
 * keeps its own flat 1.5 s wait in `ensureAndOpen`.
 */
export function startPollDelayMs(attempt: number): number {
  if (attempt <= 1) return 300;
  if (attempt === 2) return 700;
  return 1_500;
}

/**
 * Whether `ensureAndOpen` must await `GET <sandbox>/kortix/health` before it
 * opens the thread (COR-185). `/start` answering `stage: 'ready'` with the
 * runtime's root session already proves the runtime is up, so the thread opens at once
 * and the probe runs in the background (it still keeps the proxy route warm).
 * Any other answer waits for the probe: it reports `boot_error`.
 */
export function shouldAwaitHealthProbe(start: {
  stage: string;
  runtime_session_id?: string | null;
}): boolean {
  return !(start.stage === 'ready' && Boolean(start.runtime_session_id));
}

/** The sandbox image step of a provisioning `/start` answer (`boot.image`). */
export type SessionImageStep = NonNullable<NonNullable<SessionStartResult['boot']>['image']>;

/**
 * What the connecting screen says the session waits on: `/start`'s
 * `boot.image` while the box provisions, else null. The rule `@kortix/sdk`'s
 * `useSession().bootImage` follows on web: a ready answer, any other boot
 * phase, and an API without the field read null.
 */
export function sessionImageStep(
  start: Pick<SessionStartResult, 'stage' | 'boot'>,
): SessionImageStep | null {
  if (start.stage === 'ready' || start.boot?.phase !== 'provisioning') return null;
  return start.boot.image ?? null;
}

/**
 * How long `ensureAndOpen` waits for the session before it fails it. A first
 * image build takes minutes, so every answer that reports an image step moves
 * the deadline to `MAX_START_WAIT_MS` after that answer: the loop gives up only
 * when the server has said nothing about an image for that long. A failed
 * build still ends the loop at once (`stage: failed`).
 */
export const MAX_START_WAIT_MS = 4 * 60_000;

export function startWaitDeadline(deadline: number, now: number, image: SessionImageStep | null): number {
  return image ? Math.max(deadline, now + MAX_START_WAIT_MS) : deadline;
}

/** `m:ss` from `since` to `now`. A `since` ahead of this clock reads `0:00`. */
export function formatImageElapsed(since: string, now: number): string {
  const start = Date.parse(since);
  const seconds = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1_000)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
