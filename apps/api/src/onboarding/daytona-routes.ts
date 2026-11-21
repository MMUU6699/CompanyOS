import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import {
  DaytonaStructuredError,
  claimDaytonaConnect,
  classifyDaytonaError,
  disconnectUserDaytona,
  getDaytonaOnboardingStatus,
  isDaytonaReconnectRequiredError,
  pollDaytonaConnect,
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
  };
  status: 400 | 404 | 428 | 502 | 503;
} {
  if (isDaytonaReconnectRequiredError(err)) {
    return {
      status: 428,
      body: {
        error: 'daytona_reconnect_required',
        code: 'DAYTONA_RECONNECT_REQUIRED',
        message: err.message,
        reconnectRequired: true,
      },
    };
  }
  if (err instanceof DaytonaStructuredError) {
    const httpStatus =
      err.httpStatus === 400 || err.httpStatus === 404 || err.httpStatus === 502 || err.httpStatus === 503
        ? err.httpStatus
        : fallbackStatus;
    return {
      status: httpStatus,
      body: {
        error: fallbackError,
        code: err.code,
        message: err.message,
        reconnectRequired: err.reconnectRequired,
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
      },
    };
  }
  // Never leak raw upstream JSON strings into UI error copy.
  if (rawMessage.includes('{') || rawMessage.includes('HTTP ')) {
    console.warn(`[daytona-routes] ${fallbackError} sanitized raw error:`, rawMessage.slice(0, 300));
    const classified = classifyDaytonaError(err, rawMessage);
    return {
      status: fallbackStatus,
      body: {
        error: fallbackError,
        code: classified.code,
        message: classified.message,
        reconnectRequired: classified.reconnectRequired,
      },
    };
  }
  return {
    status: fallbackStatus,
    body: {
      error: fallbackError,
      code: 'DAYTONA_SNAPSHOT_FAILED',
      message: rawMessage || 'Unable to complete Daytona request. Please try again.',
      reconnectRequired: false,
    },
  };
}

export const daytonaOnboardingApp = new Hono<{ Variables: { userId?: string } }>();

// Step 1 (public, pre-Kortix-login): Start WorkOS Device Authorization Flow.
daytonaOnboardingApp.post('/start', async (c) => {
  try {
    const result = await startDaytonaConnect();
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

// Authenticated live status check (also refreshes pulling/inactive/failed snapshot state).
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
  await disconnectUserDaytona(userId);
  return c.json({ disconnected: true }, 200);
});
