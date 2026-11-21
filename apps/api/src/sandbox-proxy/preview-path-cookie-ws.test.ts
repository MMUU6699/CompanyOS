import { describe, expect, test } from 'bun:test';
import {
  isSecurePreviewRequest,
  previewPathSessionCookies,
  readPreviewSessionCookie,
} from '../middleware/auth-scope';
import { isPreviewPathWsOriginAllowed } from './ws-proxy';
import { config } from '../config';

describe('previewPathSessionCookies', () => {
  test('over HTTPS emits both SameSite=None and CHIPS Partitioned cookies scoped to /v1/p/', () => {
    const cookies = previewPathSessionCookies('jwt.token+1', { secure: true, maxAgeSeconds: 3600 });
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe(
      '__preview_session=jwt.token%2B1; Path=/v1/p/; HttpOnly; Max-Age=3600; Secure; SameSite=None',
    );
    expect(cookies[1]).toBe(
      '__preview_session_chips=jwt.token%2B1; Path=/v1/p/; HttpOnly; Max-Age=3600; Secure; SameSite=None; Partitioned',
    );
  });

  test('over plain HTTP falls back to SameSite=Lax without Secure', () => {
    const cookies = previewPathSessionCookies('tok', { secure: false });
    expect(cookies).toEqual([
      '__preview_session=tok; Path=/v1/p/; HttpOnly; Max-Age=3600; SameSite=Lax',
    ]);
  });
});

describe('readPreviewSessionCookie', () => {
  test('prefers the CHIPS partitioned cookie over the unpartitioned copy', () => {
    expect(
      readPreviewSessionCookie('__preview_session=old; __preview_session_chips=fresh%2Dtok'),
    ).toBe('fresh-tok');
    expect(readPreviewSessionCookie('a=1; __preview_session=fallback')).toBe('fallback');
    expect(readPreviewSessionCookie(null)).toBeNull();
  });
});

describe('isSecurePreviewRequest', () => {
  test('honors x-forwarded-proto and https URLs', () => {
    expect(
      isSecurePreviewRequest({
        url: 'http://internal/v1/p/auth',
        headers: new Headers({ 'x-forwarded-proto': 'https, http' }),
      }),
    ).toBe(true);
    expect(
      isSecurePreviewRequest({
        url: 'https://api.example.com/v1/p/auth',
        headers: new Headers(),
      }),
    ).toBe(true);
    expect(
      isSecurePreviewRequest({
        url: 'http://localhost:8008/v1/p/auth',
        headers: new Headers(),
      }),
    ).toBe(false);
  });
});

describe('isPreviewPathWsOriginAllowed', () => {
  const wsUrl = new URL('https://api.example.com/v1/p/sbx-1/6901/ws');

  test('allows same-origin iframe/worker upgrades even with cross-site ancestor metadata', () => {
    const req = new Request(wsUrl, {
      headers: {
        Host: 'api.example.com',
        Origin: 'https://api.example.com',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    expect(isPreviewPathWsOriginAllowed(req, wsUrl)).toBe(true);
  });

  test('allows the configured FRONTEND_URL origin', () => {
    const prev = config.FRONTEND_URL;
    (config as { FRONTEND_URL: string }).FRONTEND_URL = 'https://web.example.com';
    try {
      const req = new Request(wsUrl, {
        headers: { Host: 'api.example.com', Origin: 'https://web.example.com' },
      });
      expect(isPreviewPathWsOriginAllowed(req, wsUrl)).toBe(true);
    } finally {
      (config as { FRONTEND_URL: string }).FRONTEND_URL = prev;
    }
  });

  test('refuses arbitrary third-party origins and malformed origins', () => {
    const evil = new Request(wsUrl, {
      headers: { Host: 'api.example.com', Origin: 'https://evil.example' },
    });
    const bad = new Request(wsUrl, {
      headers: { Host: 'api.example.com', Origin: 'not-a-url' },
    });
    expect(isPreviewPathWsOriginAllowed(evil, wsUrl)).toBe(false);
    expect(isPreviewPathWsOriginAllowed(bad, wsUrl)).toBe(false);
  });

  test('without Origin, refuses cross-site Sec-Fetch-Site and allows non-browser/same-origin', () => {
    const cross = new Request(wsUrl, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    const same = new Request(wsUrl, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    const cli = new Request(wsUrl);
    expect(isPreviewPathWsOriginAllowed(cross, wsUrl)).toBe(false);
    expect(isPreviewPathWsOriginAllowed(same, wsUrl)).toBe(true);
    expect(isPreviewPathWsOriginAllowed(cli, wsUrl)).toBe(true);
  });
});
