import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DIRECT_ANDROID_APK_FILENAME,
  DIRECT_ANDROID_APK_URL,
} from '@kortix/ui/internal/lib/mobile-store-urls';

import { DownloadOptions } from './download-options';

for (const detected of ['macos', 'android', 'ios'] as const) {
  test(`${detected} visitors see mobile-only Android APK download and iOS Coming Soon`, () => {
    const html = renderToStaticMarkup(<DownloadOptions detected={detected} />);
    expect(html).toContain(`href="${DIRECT_ANDROID_APK_URL}"`);
    expect(html).toContain(`download="${DIRECT_ANDROID_APK_FILENAME}"`);
    expect(html).toContain('Download APK');
    expect(html).toContain('Coming Soon');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('apps.apple.com');
    expect(html).not.toContain('play.google.com');
    expect(html).not.toContain('/download/macos');
    expect(html).not.toContain('.dmg');
    expect(html).not.toContain('.exe');
    expect(html).not.toContain('.AppImage');
  });
}

test('Arabic locale renders قريباً for iOS Coming Soon', () => {
  const html = renderToStaticMarkup(<DownloadOptions detected="android" locale="ar" />);
  expect(html).toContain('قريباً');
  expect(html).toContain('تحميل APK');
  expect(html).toContain(`download="${DIRECT_ANDROID_APK_FILENAME}"`);
});
