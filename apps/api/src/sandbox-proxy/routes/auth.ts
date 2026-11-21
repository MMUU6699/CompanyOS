/**
 * Preview Auth Endpoint — POST /v1/p/auth
 *
 * Validates the user's JWT (from Authorization header) and sets a session
 * cookie (__preview_session) as a host-only cookie (no Domain= attribute).
 * This scopes the cookie to the exact origin that served the response,
 * enabling subdomain-based routing without ?token= on every request.
 *
 * Called by the frontend once on mount before loading a preview iframe.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { validateSecretKey } from '../../repositories/api-keys';
import { isKortixToken } from '../../shared/crypto';
import { getSupabase } from '../../shared/supabase';
import { makeOpenApiApp, json, auth, ErrorSchema } from '../../openapi';
import { bearerToken } from '../../shared/bearer-token';
import { setPreviewSessionCookie } from '../../middleware/auth-scope';

const COOKIE_MAX_AGE = 3600; // 1 hour

const getAuthToken = makeOpenApiApp();

getAuthToken.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['preview'],
    summary: 'Exchange a bearer token for a preview session cookie',
    description:
      'Validates the Authorization bearer token (Supabase JWT or Kortix token) and ' +
      'sets the host-only __preview_session cookie scoped to Path=/v1/p/, enabling ' +
      'subdomain-based preview routing without ?token= on every request.',
    ...auth,
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Cookie set'),
      401: json(ErrorSchema, 'Unauthorized'),
    },
  }),
  // NOTE: token comes from the Authorization header (manual read), not a typed
  // request body — keep the original header parsing + error contract verbatim.
  async (c) => {
    const authHeader = c.req.header('Authorization');
    const token: string | undefined = bearerToken(authHeader) ?? undefined;

    if (!token) {
      return c.json({ error: 'Missing Authorization header' }, 401);
    }

    // Validate token
    if (isKortixToken(token)) {
      const result = await validateSecretKey(token);
      if (!result.isValid) {
        return c.json({ error: result.error || 'Invalid Kortix token' }, 401);
      }
    } else {
      try {
        const supabase = getSupabase();
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
          return c.json({ error: 'Invalid or expired token' }, 401);
        }
      } catch {
        return c.json({ error: 'Authentication failed' }, 401);
      }
    }

    // Set session cookie(s) — host-only (no Domain= attribute) scoped to /v1/p/.
    // Over HTTPS this emits both __preview_session (SameSite=None; Secure) and
    // __preview_session_chips (SameSite=None; Secure; Partitioned) so cross-site
    // iframes/probes (e.g. Netlify web → Railway API) and new-tab loads both work.
    setPreviewSessionCookie(c, token, COOKIE_MAX_AGE);

    return c.json({ ok: true }, 200);
  },
);

// Also support OPTIONS for CORS preflight. Kept as a raw route — OpenAPI/zod
// doesn't model preflight, and it must return a bodyless 204.
getAuthToken.options('/', (c) => {
  return new Response(null, { status: 204 });
});

export { getAuthToken };
