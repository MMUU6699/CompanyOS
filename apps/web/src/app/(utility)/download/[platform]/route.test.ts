import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { DIRECT_ANDROID_APK_URL } from '@kortix/ui/internal/lib/mobile-store-urls';

import { GET } from './route';

const call = (platform: string) =>
  GET(new NextRequest(`https://kortix-computer-app.netlify.app/download/${platform}`), {
    params: Promise.resolve({ platform }),
  });

describe('GET /download/<platform>', () => {
  test('302s /download/android directly to the verified Android APK', async () => {
    const res = await call('android');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(DIRECT_ANDROID_APK_URL);
  });

  test('redirects iOS, desktop, and unknown platforms back to /download', async () => {
    for (const platform of [
      'ios',
      'iphone',
      'ipad',
      'macos',
      'mac',
      'darwin',
      'windows',
      'win',
      'linux',
      'solaris',
    ]) {
      const res = await call(platform);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://kortix-computer-app.netlify.app/download');
    }
  });
});

describe('GET /download/mobile (QR code target)', () => {
  const scan = (userAgent: string) =>
    GET(
      new NextRequest('https://kortix-computer-app.netlify.app/download/mobile', {
        headers: { 'user-agent': userAgent },
      }),
      {
        params: Promise.resolve({ platform: 'mobile' }),
      },
    );

  test('an Android phone gets redirected directly to the APK', async () => {
    const res = await scan('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(DIRECT_ANDROID_APK_URL);
  });

  test('an iPhone or desktop browser lands on /download', async () => {
    for (const ua of [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15',
    ]) {
      const res = await scan(ua);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://kortix-computer-app.netlify.app/download');
    }
  });
});
