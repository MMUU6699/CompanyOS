import { platformConfig } from '@kortix/sdk';
import { uiHostEnv } from '../../../lib/host-env';

/**
 * Origins that agent-authored frames must never share: the page itself, the
 * configured app URL, and the API (which also serves the sandbox path proxy).
 * The page origin comes first, so a relative frame URL resolves against it.
 *
 * `backendUrl` may be root-relative (`/v1` on a self-host), which puts the
 * API on the page origin; resolving it against the page covers that case.
 */
/** The web-app origins (current page and configured app URL) that no sandbox frame may share. */
export function webAppFrameOrigins(): string[] {
  const { appUrl } = uiHostEnv();
  const page = typeof window !== 'undefined' ? window.location.origin : appUrl;
  return [page, appUrl];
}

export function privilegedFrameOrigins(): string[] {
  const origins = webAppFrameOrigins();
  const page = origins[0];
  try {
    origins.push(new URL(platformConfig().backendUrl, page).origin);
  } catch {
    // An unparseable backend URL adds nothing; the page origin still applies.
  }
  return origins;
}
