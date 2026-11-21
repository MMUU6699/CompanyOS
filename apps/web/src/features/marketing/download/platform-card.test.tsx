import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DIRECT_ANDROID_APK_FILENAME,
  DIRECT_ANDROID_APK_URL,
} from '@kortix/ui/internal/lib/mobile-store-urls';

import { MOBILE_CARD, MOBILE_ROWS } from './content';
import { type CardRow, PlatformCard } from './platform-card';

const Mark = () => <svg />;

const mobileRows: CardRow[] = [
  {
    id: 'android',
    label: MOBILE_ROWS.android.label,
    meta: MOBILE_ROWS.android.hint,
    href: MOBILE_ROWS.android.href,
    downloadFilename: DIRECT_ANDROID_APK_FILENAME,
    actionLabel: 'Download APK',
    Mark,
  },
  {
    id: 'ios',
    label: MOBILE_ROWS.ios.label,
    meta: MOBILE_ROWS.ios.hint,
    href: MOBILE_ROWS.ios.href,
    comingSoon: true,
    comingSoonLabel: 'Coming Soon',
    Mark,
  },
];

const mobileCard = renderToStaticMarkup(
  <PlatformCard
    image={null}
    title={MOBILE_CARD.title}
    description={MOBILE_CARD.description}
    rows={mobileRows}
    filled="android"
  />,
);

describe('the mobile-only card', () => {
  test('renders direct Android APK download with zero app store links', () => {
    expect(mobileCard).toContain(`href="${DIRECT_ANDROID_APK_URL}"`);
    expect(mobileCard).toContain(`download="${DIRECT_ANDROID_APK_FILENAME}"`);
    expect(mobileCard).toContain('Download APK');
    expect(mobileCard).not.toContain('apps.apple.com');
    expect(mobileCard).not.toContain('play.google.com');
    expect(mobileCard).not.toContain('target="_blank"');
  });

  test('renders a non-clickable Coming Soon badge for iOS', () => {
    expect(mobileCard).toContain('Coming Soon');
    expect(mobileCard).toContain('aria-disabled="true"');
    expect(mobileCard).not.toContain('Open App Store');
    expect(mobileCard).not.toContain('Open Google Play');
  });

  test('highlights the Android direct APK button as solid primary CTA', () => {
    expect(mobileCard.match(/ bg-foreground /g)).toHaveLength(1);
  });
});
