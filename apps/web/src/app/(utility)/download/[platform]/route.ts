import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { DIRECT_ANDROID_APK_URL } from '@kortix/ui/internal/lib/mobile-store-urls';

import { detectPlatform, normalizePlatform } from '@kortix/ui/internal/lib/detect-os';

/**
 * Mobile-only download redirector:
 *
 *   /download/android → direct APK download (`kortix-latest.apk`)
 *   /download/mobile  → direct APK on Android phones, else `/download`
 *   All other platforms (iOS / desktop / unknown) → `/download`
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform } = await params;
  if (platform.toLowerCase() === 'mobile') {
    const detected = detectPlatform(request.headers.get('user-agent'));
    if (detected === 'android') return NextResponse.redirect(DIRECT_ANDROID_APK_URL, 302);
    return NextResponse.redirect(new URL('/download', request.url), 302);
  }

  const os = normalizePlatform(platform);
  if (os === 'android') return NextResponse.redirect(DIRECT_ANDROID_APK_URL, 302);
  return NextResponse.redirect(new URL('/download', request.url), 302);
}
