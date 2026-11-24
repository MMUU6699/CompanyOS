import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../lib/logger';
import { supabaseAuth } from '../middleware/auth';
import { requestClientKey } from '../middleware/client-ip';
import {
  DaytonaStructuredError,
  claimDaytonaConnect,
  classifyDaytonaError,
  disconnectUserDaytona,
  getDaytonaOnboardingStatus,
  isDaytonaNotConnectedError,
  isDaytonaReconnectRequiredError,
  pollDaytonaConnect,
  retryUserDaytonaSnapshot,
  saveManualDaytonaKey,
  startDaytonaConnect,
} from './daytona-service';

const pollBodySchema = z.object({
  flowId: z.string().uuid('flowId must be a valid UUID'),
});

const claimBodySchema = z.object({
  claimToken: z.string().min(16, 'claimToken is required').max(256),
});

const manualKeyBodySchema = z.object({
  apiKey: z.string().min(16, 'apiKey is required').max(512),
  region: z.string().trim().min(2).max(32).optional(),
});

type RouteErrorStatus = 400 | 402 | 403 | 404 | 428 | 429 | 500 | 502 | 503 | 504;

function normalizeStatus(status: number, fallback: RouteErrorStatus): RouteErrorStatus {
  if (
    status === 400 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 428 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return status;
  }
  return fallback;
}

function formatRouteError(
  err: unknown,
  fallbackError: string,
  fallbackStatus: 400 | 404 | 502 = 502,
): {
  body: {
    error: string;
    code: string;
    message: string;
    reconnectRequired: boolean;
    retriable: boolean;
  };
  status: RouteErrorStatus;
} {
  if (isDaytonaNotConnectedError(err)) {
    return {
      status: 428,
      body: {
        error: 'daytona_not_connected',
        code: 'DAYTONA_NOT_CONNECTED',
        message: err.message,
        reconnectRequired: true,
        retriable: false,
      },
    };
  }
  if (isDaytonaReconnectRequiredError(err)) {
    return {
      status: 428,
      body: {
        error: 'daytona_reconnect_required',
        code: 'DAYTONA_RECONNECT_REQUIRED',
        message: err.message,
        reconnectRequired: true,
        retriable: false,
      },
    };
  }
  if (err instanceof DaytonaStructuredError) {
    return {
      status: normalizeStatus(err.httpStatus, fallbackStatus),
      body: {
        error: fallbackError,
        code: err.code,
        message: err.message,
        reconnectRequired: err.reconnectRequired,
        retriable: err.retriable,
      },
    };
  }
  const rawMessage = err instanceof Error ? err.message : String(err);
  if (rawMessage.includes('not found')) {
    return {
      status: 404,
      body: {
        error: fallbackError,
        code: 'DAYTONA_TIMEOUT',
        message: 'This Daytona sign-in session expired. Start a new connection to continue.',
        reconnectRequired: false,
        retriable: true,
      },
    };
  }
  // Never leak raw upstream JSON strings or HTTP error bodies into UI error copy.
  if (rawMessage.includes('{') || rawMessage.includes('HTTP ')) {
    logger.warn('[daytona-routes] sanitized upstream Daytona error', {
      fallbackError,
      rawMessage: rawMessage.slice(0, 300),
    });
    const classified = classifyDaytonaError(err, rawMessage);
    return {
      status: normalizeStatus(classified.httpStatus, fallbackStatus),
      body: {
        error: fallbackError,
        code: classified.code,
        message: classified.message,
        reconnectRequired: classified.reconnectRequired,
        retriable: classified.retriable,
      },
    };
  }
  const classified = classifyDaytonaError(err, rawMessage);
  return {
    status: normalizeStatus(classified.httpStatus, fallbackStatus),
    body: {
      error: fallbackError,
      code: classified.code,
      message: rawMessage || classified.message,
      reconnectRequired: classified.reconnectRequired,
      retriable: classified.retriable,
    },
  };
}

export const daytonaOnboardingApp = new Hono<{ Variables: { userId?: string } }>();

// Step 1 (public, pre-Kortix-login): Start WorkOS Device Authorization Flow.
daytonaOnboardingApp.post('/start', async (c) => {
  try {
    const clientKey = requestClientKey(c);
    const clientIpHash =
      clientKey && clientKey !== 'unknown'
        ? createHash('sha256').update(`${clientKey}:${config.API_KEY_SECRET}`).digest('hex')
        : null;
    const result = await startDaytonaConnect({ clientIpHash });
    return c.json(result, 200);
  } catch (err) {
    const formatted = formatRouteError(err, 'daytona_connect_start_failed', 502);
    return c.json(formatted.body, formatted.status);
  }
});

// Step 1 (public, pre-Kortix-login): Poll WorkOS Device Flow, set defaultRegionId & auto-mint permanent key.
daytonaOnboardingApp.post('/poll', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = pollBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_request',
        code: 'INVALID_REQUEST',
        message: parsed.error.issues[0]?.message || 'Invalid flowId',
        reconnectRequired: false,
      },
      400,
    );
  }
  try {
    const result = await pollDaytonaConnect(parsed.data.flowId);
    return c.json(result, 200);
  } catch (err) {
    const formatted = formatRouteError(err, 'daytona_connect_poll_failed', 502);
    return c.json(formatted.body, formatted.status);
  }
});

// Step 2 (authenticated): Bind approved Daytona key to authenticated Supabase user_id.
daytonaOnboardingApp.post('/claim', supabaseAuth, async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) {
    return c.json({ error: 'unauthorized', message: 'Authentication required' }, 401);
  }
  const raw = await c.req.json().catch(() => null);
  const parsed = claimBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_request',
        code: 'INVALID_REQUEST',
        message: parsed.error.issues[0]?.message || 'Invalid claimToken',
        reconnectRequired: false,
      },
      400,
    );
  }
  try {
    const result = await claimDaytonaConnect(userId, parsed.data.claimToken);
    return c.json(result, 200);
  } catch (err) {
    const formatted = formatRouteError(err, 'daytona_claim_failed', 400);
    return c.json(formatted.body, formatted.status);
  }
});

// Authenticated read-only status check (never mutates Daytona).
daytonaOnboardingApp.get('/status', supabaseAuth, async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) {
    return c.json({ error: 'unauthorized', message: 'Authentication required' }, 401);
  }
  try {
    const result = await getDaytonaOnboardingStatus(userId);
    return c.json(result, 200);
  } catch (err) {
    const formatted = formatRouteError(err, 'daytona_status_failed', 502);
    return c.json(formatted.body, formatted.status);
  }
});

// Authenticated explicit snapshot create/activate/retry endpoint.
daytonaOnboardingApp.post('/retry', supabaseAuth, async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) {
    return c.json({ error: 'unauthorized', message: 'Authentication required' }, 401);
  }
  try {
    const result = await retryUserDaytonaSnapshot(userId);
    return c.json(result, 200);
  } catch (err) {
    const formatted = formatRouteError(err, 'daytona_snapshot_retry_failed', 502);
    return c.json(formatted.body, formatted.status);
  }
});

// Authenticated manual fallback: validate & store a pasted dtn_... API key.
daytonaOnboardingApp.post('/manual-key', supabaseAuth, async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) {
    return c.json({ error: 'unauthorized', message: 'Authentication required' }, 401);
  }
  const raw = await c.req.json().catch(() => null);
  const parsed = manualKeyBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_request',
        code: 'INVALID_REQUEST',
        message: parsed.error.issues[0]?.message || 'Invalid apiKey',
        reconnectRequired: false,
      },
      400,
    );
  }
  try {
    const result = await saveManualDaytonaKey(userId, parsed.data.apiKey, parsed.data.region);
    return c.json(result, 200);
  } catch (err) {
    const formatted = formatRouteError(err, 'daytona_manual_key_failed', 400);
    return c.json(formatted.body, formatted.status);
  }
});

// Authenticated disconnect helper for reconnecting a different Daytona org.
daytonaOnboardingApp.delete('/disconnect', supabaseAuth, async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) {
    return c.json({ error: 'unauthorized', message: 'Authentication required' }, 401);
  }
  const result = await disconnectUserDaytona(userId);
  return c.json(result, 200);
});
