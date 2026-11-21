import { AndroidMark, AppleMark } from '@/components/brand/brand-logos';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import type { MobileOs, Platform } from '@kortix/ui/internal/lib/detect-os';
import { isMobilePlatform } from '@kortix/ui/internal/lib/detect-os';
import { DIRECT_ANDROID_APK_FILENAME } from '@kortix/ui/internal/lib/mobile-store-urls';

import { MobileCardImage } from './card-images';
import { localizedDownloadContent } from './content';
import { MobileQrRow } from './mobile-qr-row';
import type { CardRow } from './platform-card';
import { PlatformCard } from './platform-card';

const MOBILE_DISPLAY_ORDER: readonly MobileOs[] = ['android', 'ios'];

const MOBILE_MARKS: Record<MobileOs, CardRow['Mark']> = {
  android: AndroidMark,
  ios: AppleMark,
};

/**
 * Centered mobile-only download card: Android direct APK download plus a
 * non-clickable iOS Coming Soon badge. A non-phone visitor also sees the QR row
 * pointing to `/download/mobile`.
 */
export function DownloadOptions({
  detected,
  locale,
}: {
  detected: Platform;
  locale?: string;
}) {
  const detectedLocale = useLocale();
  const activeLocale = locale ?? detectedLocale;
  const isArabic = activeLocale.toLowerCase().startsWith('ar');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { mobileCard, mobileRows } = localizedDownloadContent(tI18nComplete);
  const onPhone = isMobilePlatform(detected);

  return (
    <div className="mx-auto w-full max-w-lg">
      <PlatformCard
        image={<MobileCardImage />}
        title={mobileCard.title}
        description={mobileCard.description}
        aside={onPhone ? null : <MobileQrRow />}
        rows={MOBILE_DISPLAY_ORDER.map((os) => {
          const row = mobileRows[os];
          if (os === 'android') {
            return {
              id: os,
              label: row.label,
              meta: row.hint,
              href: row.href,
              downloadFilename: DIRECT_ANDROID_APK_FILENAME,
              actionLabel: isArabic ? 'تحميل APK' : 'Download APK',
              Mark: MOBILE_MARKS.android,
            };
          }
          return {
            id: os,
            label: row.label,
            meta: row.hint,
            href: '',
            comingSoon: true,
            comingSoonLabel: isArabic ? 'قريباً' : 'Coming Soon',
            Mark: MOBILE_MARKS.ios,
          };
        })}
        filled="android"
      />
    </div>
  );
}
