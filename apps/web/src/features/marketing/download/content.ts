/**
 * `/download` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so copy can
 * iterate before paying the 8-locale parity gate. Same precedent as
 * `features/marketing/self-hosted/content.ts`.
 *
 * ACCURACY GATE — every string below is checked against the live GitHub release
 * (v0.11.0, 2026-07-28), not against docs:
 *  1. macOS ships ONE universal .dmg. Never advertise separate Apple Silicon
 *     and Intel desktop builds — they do not exist.
 *  2. Linux desktop is x86_64 ONLY. There is no arm64 AppImage. The row says so
 *     rather than letting an ARM visitor download a binary that will not run.
 *  3. There is NO Windows CLI binary. The install script is bash-only, so the
 *     terminal block says "macOS & Linux · WSL on Windows".
 *  4. The Chrome extension (apps/chrome-extension) is not public in the
 *     Chrome Web Store yet. The page must not advertise it until it is.
 *  5. Mobile-only release: Android is distributed as a direct APK download
 *     from our verified release host, and iOS is marked Coming Soon.
 */

import { localizeUiCatalog } from '@kortix/ui/i18n';
import { REMAINING_UI_TRANSLATION_KEYS } from '@kortix/ui/i18n/ui-catalog/remaining-ui-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';
import type { MobileOs } from '@kortix/ui/internal/lib/detect-os';
import {
  DIRECT_ANDROID_APK_SIZE_LABEL,
  DIRECT_ANDROID_APK_URL,
} from '@kortix/ui/internal/lib/mobile-store-urls';

export const hero = {
  title: 'Download Kortix',
  sub: 'Download the Kortix Android app directly via APK. iOS support is coming soon.',
};

export type CardCopy = { title: string; description: string };
export type RowCopy = { label: string; hint: string; href: string };

export const MOBILE_CARD: CardCopy = {
  title: 'Mobile app',
  description: 'Start a session on your phone and pick up where you left off.',
};

/** Direct mobile APK link and iOS availability copy. */
export const MOBILE_ROWS: Record<MobileOs, RowCopy> = {
  android: {
    label: 'Android',
    hint: `Direct APK · ${DIRECT_ANDROID_APK_SIZE_LABEL} · arm64`,
    href: DIRECT_ANDROID_APK_URL,
  },
  ios: {
    label: 'iPhone and iPad',
    hint: 'iOS',
    href: '',
  },
};

export const TERMINAL = {
  title: 'Terminal',
  description: 'Install the CLI and drive Kortix from your shell.',
  support: 'macOS & Linux · WSL on Windows',
};

export function localizedDownloadContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    {
      hero,
      mobileCard: MOBILE_CARD,
      mobileRows: MOBILE_ROWS,
      terminal: TERMINAL,
    },
    tI18nComplete,
    REMAINING_UI_TRANSLATION_KEYS,
  );
}
