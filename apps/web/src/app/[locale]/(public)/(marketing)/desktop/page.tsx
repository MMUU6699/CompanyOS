import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import { redirect } from 'next/navigation';

/** `/desktop` is deprecated in favor of mobile-only downloads at `/download`. */
export const generateMetadata = () => localizedMarketingMetadata('/download');

export default function DesktopRedirectPage() {
  redirect('/download');
}
