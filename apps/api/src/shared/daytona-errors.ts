/**
 * Shared Daytona error types and classifier (layer 0).
 *
 * Used across onboarding, sandbox provisioning, session wake, compute-quota
 * guard, and top-level HTTP error handling so every Daytona failure produces a
 * consistent typed code + user-facing message (never raw upstream text).
 */

export type DaytonaErrorCode =
  | 'DAYTONA_NOT_CONNECTED'
  | 'DAYTONA_RECONNECT_REQUIRED'
  | 'DAYTONA_ORG_SUSPENDED'
  | 'DAYTONA_QUOTA_EXCEEDED'
  | 'DAYTONA_SNAPSHOT_BUILDING'
  | 'DAYTONA_REGION_REQUIRED'
  | 'DAYTONA_EMAIL_UNVERIFIED'
  | 'DAYTONA_SNAPSHOT_FAILED'
  | 'DAYTONA_SNAPSHOT_CONFIG_INVALID'
  | 'DAYTONA_TIMEOUT'
  | 'DAYTONA_TOO_MANY_FLOWS'
  | 'DAYTONA_RATE_LIMITED';

/** Backward-compatible alias for onboarding callers. */
export type DaytonaOnboardingErrorCode = DaytonaErrorCode;

export interface ClassifiedDaytonaError {
  code: DaytonaErrorCode;
  message: string;
  retriable: boolean;
  reconnectRequired: boolean;
  httpStatus: number;
}

export const DAYTONA_HUMAN_ERROR_COPY: Record<DaytonaErrorCode, string> = {
  DAYTONA_NOT_CONNECTED:
    'Connect your Daytona account in Settings -> Cloud computer to start a session.',
  DAYTONA_RECONNECT_REQUIRED:
    'Your Daytona connection expired or was revoked. Reconnect Daytona in Settings -> Cloud computer to continue.',
  DAYTONA_ORG_SUSPENDED:
    'Your Daytona workspace is suspended (for example, depleted free credits or billing hold). Add credits or resolve the hold in your Daytona dashboard, or connect a different Daytona account in Settings -> Cloud computer.',
  DAYTONA_QUOTA_EXCEEDED:
    'Your Daytona workspace reached its active resource or storage limit. Stop or archive an unused session, or try again in a moment.',
  DAYTONA_SNAPSHOT_BUILDING:
    'Your private Daytona cloud computer image is still being prepared. Your message is queued and will run automatically as soon as it is ready.',
  DAYTONA_REGION_REQUIRED:
    'Your Daytona workspace needs a default region selected. Reconnect Daytona and Kortix will configure it automatically.',
  DAYTONA_EMAIL_UNVERIFIED:
    'Please verify your email address in Daytona, then retry setup.',
  DAYTONA_SNAPSHOT_FAILED:
    'We could not prepare your private cloud computer image right now. Tap retry or reconnect Daytona.',
  DAYTONA_SNAPSHOT_CONFIG_INVALID:
    'Kortix sandbox image configuration is invalid on the server. Contact your administrator.',
  DAYTONA_TIMEOUT:
    'Daytona took too long to respond. Try again in a moment.',
  DAYTONA_TOO_MANY_FLOWS:
    'Too many active Daytona connection attempts from this address. Wait a minute and try again.',
  DAYTONA_RATE_LIMITED:
    'Daytona is temporarily rate-limiting requests. Wait a few seconds and try again.',
};

const CODE_POLICY: Record<
  DaytonaErrorCode,
  { retriable: boolean; reconnectRequired: boolean; httpStatus: number }
> = {
  DAYTONA_NOT_CONNECTED: { retriable: false, reconnectRequired: true, httpStatus: 428 },
  DAYTONA_RECONNECT_REQUIRED: { retriable: false, reconnectRequired: true, httpStatus: 428 },
  DAYTONA_ORG_SUSPENDED: { retriable: false, reconnectRequired: false, httpStatus: 402 },
  DAYTONA_QUOTA_EXCEEDED: { retriable: true, reconnectRequired: false, httpStatus: 429 },
  DAYTONA_SNAPSHOT_BUILDING: { retriable: true, reconnectRequired: false, httpStatus: 503 },
  DAYTONA_REGION_REQUIRED: { retriable: false, reconnectRequired: true, httpStatus: 428 },
  DAYTONA_EMAIL_UNVERIFIED: { retriable: false, reconnectRequired: false, httpStatus: 403 },
  DAYTONA_SNAPSHOT_FAILED: { retriable: true, reconnectRequired: false, httpStatus: 502 },
  DAYTONA_SNAPSHOT_CONFIG_INVALID: { retriable: false, reconnectRequired: false, httpStatus: 500 },
  DAYTONA_TIMEOUT: { retriable: true, reconnectRequired: false, httpStatus: 504 },
  DAYTONA_TOO_MANY_FLOWS: { retriable: true, reconnectRequired: false, httpStatus: 429 },
  DAYTONA_RATE_LIMITED: { retriable: true, reconnectRequired: false, httpStatus: 429 },
};

export function humanMessageForDaytonaCode(code: DaytonaErrorCode): string {
  return DAYTONA_HUMAN_ERROR_COPY[code];
}

export function isDaytonaErrorCode(value: unknown): value is DaytonaErrorCode {
  return typeof value === 'string' && value in DAYTONA_HUMAN_ERROR_COPY;
}

export class DaytonaStructuredError extends Error {
  readonly code: DaytonaErrorCode;
  readonly httpStatus: number;
  readonly reconnectRequired: boolean;
  readonly retriable: boolean;

  constructor(
    code: DaytonaErrorCode,
    message = DAYTONA_HUMAN_ERROR_COPY[code],
    httpStatus = CODE_POLICY[code].httpStatus,
    retriable = CODE_POLICY[code].retriable,
  ) {
    super(message);
    this.name = 'DaytonaStructuredError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retriable = retriable;
    this.reconnectRequired = CODE_POLICY[code].reconnectRequired;
  }
}

export class DaytonaReconnectRequiredError extends DaytonaStructuredError {
  readonly legacyCode = 'daytona_reconnect_required' as const;
  readonly status = 428;

  constructor(message = DAYTONA_HUMAN_ERROR_COPY.DAYTONA_RECONNECT_REQUIRED) {
    super('DAYTONA_RECONNECT_REQUIRED', message, 428, false);
    this.name = 'DaytonaReconnectRequiredError';
  }
}

export class DaytonaNotConnectedError extends DaytonaStructuredError {
  readonly legacyCode = 'daytona_not_connected' as const;
  readonly status = 428;

  constructor(message = DAYTONA_HUMAN_ERROR_COPY.DAYTONA_NOT_CONNECTED) {
    super('DAYTONA_NOT_CONNECTED', message, 428, false);
    this.name = 'DaytonaNotConnectedError';
  }
}

export class DaytonaOrgSuspendedError extends DaytonaStructuredError {
  readonly status = 402;

  constructor(message = DAYTONA_HUMAN_ERROR_COPY.DAYTONA_ORG_SUSPENDED) {
    super('DAYTONA_ORG_SUSPENDED', message, 402, false);
    this.name = 'DaytonaOrgSuspendedError';
  }
}

export class DaytonaAllSandboxesBusyError extends DaytonaStructuredError {
  readonly status = 503;

  constructor(
    message = 'All active cloud computers in your Daytona workspace are currently running tasks. Your session will start automatically as soon as one becomes idle.',
  ) {
    super('DAYTONA_QUOTA_EXCEEDED', message, 503, true);
    this.name = 'DaytonaAllSandboxesBusyError';
  }
}

export function isDaytonaStructuredError(err: unknown): err is DaytonaStructuredError {
  if (err instanceof DaytonaStructuredError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return isDaytonaErrorCode(code) && typeof (err as { httpStatus?: unknown }).httpStatus === 'number';
}

export function isDaytonaReconnectRequiredError(
  err: unknown,
): err is DaytonaReconnectRequiredError {
  if (err instanceof DaytonaReconnectRequiredError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'daytona_reconnect_required' || code === 'DAYTONA_RECONNECT_REQUIRED';
}

export function isDaytonaNotConnectedError(err: unknown): err is DaytonaNotConnectedError {
  if (err instanceof DaytonaNotConnectedError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'daytona_not_connected' || code === 'DAYTONA_NOT_CONNECTED';
}

export function isDaytonaOrgSuspendedError(err: unknown): err is DaytonaOrgSuspendedError {
  if (err instanceof DaytonaOrgSuspendedError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'daytona_org_suspended' || code === 'DAYTONA_ORG_SUSPENDED';
}

export function isDaytonaAllSandboxesBusyError(err: unknown): err is DaytonaAllSandboxesBusyError {
  if (err instanceof DaytonaAllSandboxesBusyError) return true;
  if (typeof err !== 'object' || err === null) return false;
  return (err as { name?: unknown }).name === 'DaytonaAllSandboxesBusyError';
}

/** True when `err` looks like an Error thrown by `@daytonaio/sdk` or our Daytona layer. */
export function isDaytonaErrorLike(err: unknown): boolean {
  if (isDaytonaStructuredError(err) || isDaytonaReconnectRequiredError(err) || isDaytonaNotConnectedError(err)) {
    return true;
  }
  if (typeof err !== 'object' || err === null) return false;
  const name = String((err as { name?: unknown }).name ?? '');
  const ctor = String((err as { constructor?: { name?: unknown } }).constructor?.name ?? '');
  return name.startsWith('Daytona') || ctor.startsWith('Daytona');
}

function buildClassified(
  code: DaytonaErrorCode,
  message = DAYTONA_HUMAN_ERROR_COPY[code],
): ClassifiedDaytonaError {
  const policy = CODE_POLICY[code];
  return {
    code,
    message,
    retriable: policy.retriable,
    reconnectRequired: policy.reconnectRequired,
    httpStatus: policy.httpStatus,
  };
}

/**
 * Classify any Daytona SDK error, HTTP status, or stored error string into a
 * stable typed code, human-readable message, and retriability flag.
 */
export function classifyDaytonaError(
  statusOrErr: number | unknown,
  rawBodyOrMessage = '',
): ClassifiedDaytonaError {
  if (isDaytonaStructuredError(statusOrErr)) {
    return {
      code: statusOrErr.code,
      message: statusOrErr.message || DAYTONA_HUMAN_ERROR_COPY[statusOrErr.code],
      retriable: statusOrErr.retriable,
      reconnectRequired: statusOrErr.reconnectRequired,
      httpStatus: statusOrErr.httpStatus,
    };
  }
  if (isDaytonaNotConnectedError(statusOrErr)) {
    return buildClassified('DAYTONA_NOT_CONNECTED', statusOrErr.message);
  }
  if (isDaytonaReconnectRequiredError(statusOrErr)) {
    return buildClassified('DAYTONA_RECONNECT_REQUIRED', statusOrErr.message);
  }

  const errObj =
    typeof statusOrErr === 'object' && statusOrErr !== null
      ? (statusOrErr as {
          name?: unknown;
          code?: unknown;
          status?: number;
          statusCode?: number;
          response?: { status?: number };
        })
      : null;

  if (errObj?.name === 'SnapshotStillBuildingError') {
    return buildClassified('DAYTONA_SNAPSHOT_BUILDING');
  }
  if (isDaytonaErrorCode(errObj?.code)) {
    return buildClassified(errObj.code);
  }

  const status =
    typeof statusOrErr === 'number'
      ? statusOrErr
      : (errObj?.status ?? errObj?.statusCode ?? errObj?.response?.status ?? 0);

  const rawText =
    rawBodyOrMessage ||
    (statusOrErr instanceof Error
      ? statusOrErr.message
      : typeof statusOrErr === 'string'
        ? statusOrErr
        : '');
  const lower = rawText.toLowerCase();

  if (lower.includes('daytona_not_connected') || lower.includes('connect your daytona account')) {
    return buildClassified('DAYTONA_NOT_CONNECTED');
  }

  if (
    lower.includes('daytona_snapshot_building') ||
    lower.includes('snapshot is still building') ||
    lower.includes('still being prepared') ||
    lower.includes('snapshot_still_building')
  ) {
    return buildClassified('DAYTONA_SNAPSHOT_BUILDING');
  }

  if (
    lower.includes('daytona_snapshot_config_invalid') ||
    lower.includes('kortix_sandbox_ghcr_image')
  ) {
    return buildClassified('DAYTONA_SNAPSHOT_CONFIG_INVALID');
  }

  if (
    lower.includes('default region') ||
    lower.includes('defaultregion') ||
    lower.includes('daytona_region_required')
  ) {
    return buildClassified('DAYTONA_REGION_REQUIRED');
  }

  if (
    lower.includes('email_access_denied') ||
    lower.includes('primary or work email')
  ) {
    return buildClassified(
      'DAYTONA_EMAIL_UNVERIFIED',
      'Daytona requires a primary or work email address (temporary or aliased emails are blocked). Sign in to Daytona with a primary email, Google, or GitHub account, then tap New code.',
    );
  }

  if (
    lower.includes('daytona_email_unverified') ||
    lower.includes('verify your email') ||
    lower.includes('email verification')
  ) {
    return buildClassified('DAYTONA_EMAIL_UNVERIFIED');
  }

  if (
    lower.includes('daytona_org_suspended') ||
    lower.includes('organization is suspended') ||
    lower.includes('workspace is suspended') ||
    lower.includes('depleted credits') ||
    lower.includes('out of credits') ||
    lower.includes('insufficient credits') ||
    lower.includes('credits depleted') ||
    lower.includes('credits exhausted') ||
    lower.includes('billing suspended') ||
    lower.includes('suspended')
  ) {
    const depleted =
      lower.includes('depleted credits') ||
      lower.includes('out of credits') ||
      lower.includes('insufficient credits') ||
      lower.includes('credits depleted') ||
      lower.includes('credits exhausted');
    return buildClassified(
      'DAYTONA_ORG_SUSPENDED',
      depleted
        ? 'Your Daytona workspace ran out of credits and is suspended. Add credits in your Daytona dashboard, or connect a different Daytona account in Settings -> Cloud computer.'
        : DAYTONA_HUMAN_ERROR_COPY.DAYTONA_ORG_SUSPENDED,
    );
  }

  if (
    status === 401 ||
    status === 403 ||
    lower.includes('daytona_reconnect_required') ||
    lower.includes('invalid api key') ||
    lower.includes('invalid credentials') ||
    lower.includes('api key is revoked') ||
    lower.includes('unauthorized')
  ) {
    return buildClassified('DAYTONA_RECONNECT_REQUIRED');
  }

  if (
    status === 429 ||
    lower.includes('throttlerexception') ||
    lower.includes('too many requests') ||
    lower.includes('rate limit')
  ) {
    return buildClassified('DAYTONA_RATE_LIMITED');
  }

  if (
    status === 402 ||
    lower.includes('daytona_quota_exceeded') ||
    lower.includes('quota') ||
    lower.includes('limit exceeded') ||
    lower.includes('disk limit') ||
    lower.includes('memory limit') ||
    lower.includes('cpu limit') ||
    lower.includes('concurrency limit') ||
    lower.includes('currently running tasks')
  ) {
    return buildClassified('DAYTONA_QUOTA_EXCEEDED');
  }

  if (
    status === 408 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    lower.includes('daytona_timeout') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('aborted') ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed')
  ) {
    return buildClassified('DAYTONA_TIMEOUT');
  }

  return buildClassified('DAYTONA_SNAPSHOT_FAILED');
}

export function sanitizeStoredDaytonaError(
  stored: string | null | undefined,
): ClassifiedDaytonaError | null {
  if (!stored || !stored.trim()) return null;
  const trimmed = stored.trim();
  if (isDaytonaErrorCode(trimmed)) {
    return buildClassified(trimmed);
  }
  return classifyDaytonaError(0, trimmed);
}
