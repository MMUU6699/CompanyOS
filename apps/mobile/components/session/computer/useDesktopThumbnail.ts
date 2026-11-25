/**
 * Low-rate (<= 0.5 fps) live desktop thumbnail fetcher for `ComputerDock`.
 *
 * Fetches `GET /v1/p/:externalId/6901/screenshot` with Bearer auth (gated
 * strictly by `isTrustedProxyUrl`) ONLY while:
 *   1) the agent is actively using Browser,
 *   2) the app is in the foreground (`AppState === 'active'`), and
 *   3) the full `ComputerSheet` is NOT open.
 *
 * Never streams video while only the dock is visible.
 */

import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { authenticatedRequest } from '@kortix/sdk';

import { API_URL } from '@/api/config';
import { isTrustedProxyUrl } from '@/lib/utils/html-embed';

const THUMBNAIL_POLL_MS = 2_000; // 0.5 fps (strictly <= 1 fps)

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[b2 & 63] : '=';
  }
  return out;
}

export function useDesktopThumbnail(
  screenshotUrl: string | null,
  enabled: boolean,
): string | null {
  const [uri, setUri] = useState<string | null>(null);
  const [foreground, setForeground] = useState<boolean>(
    () => AppState.currentState === 'active',
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      setForeground(next === 'active');
    });
    return () => sub.remove();
  }, []);

  const trusted = Boolean(screenshotUrl && isTrustedProxyUrl(screenshotUrl, API_URL));
  const active = Boolean(enabled && foreground && trusted && screenshotUrl);

  useEffect(() => {
    if (!active || !screenshotUrl) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;

    const capture = async () => {
      controller = new AbortController();
      try {
        const { headers } = await authenticatedRequest(screenshotUrl);
        if (!alive) return;
        const res = await fetch(screenshotUrl, {
          headers,
          signal: controller.signal,
        });
        if (!alive) return;
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (alive && buf.byteLength > 128) {
            setUri(`data:image/png;base64,${arrayBufferToBase64(buf)}`);
          }
        }
      } catch {
        // Silent retry on next tick; dock falls back to browser wireframe.
      }
      if (alive) {
        timer = setTimeout(() => void capture(), THUMBNAIL_POLL_MS);
      }
    };

    void capture();

    return () => {
      alive = false;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [active, screenshotUrl]);

  return uri;
}
