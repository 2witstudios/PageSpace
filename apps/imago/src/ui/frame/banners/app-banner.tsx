'use client';

import { useRouter } from 'next/navigation';
import { bannerActionClass, renderBannerSlot } from './banner-slot.render';
import { bannerPriority, pickBanner, type Banner } from './banner-registry';
import { useOnline } from './use-online';
import { useVerifyEmailBanner } from './verify-email-banner';

/**
 * The shell's banner slot. It gathers every banner that applies right now and shows the highest
 * priority one: offline and verify-email are live; the conflict banner stays inside its document
 * view, and the org-lapse banners join here with the orgs branch.
 */
export function AppBanner() {
  const online = useOnline();
  const router = useRouter();
  const verify = useVerifyEmailBanner();
  const offline: Banner | null = online
    ? null
    : {
        id: 'offline',
        priority: bannerPriority.offline,
        tone: 'warning',
        message: (
          <>
            <strong className="font-semibold">You’re offline.</strong> Check your internet connection and try again. Some
            features may be available from cache.
          </>
        ),
        actions: (
          <button type="button" className={bannerActionClass} onClick={() => router.refresh()}>
            Try again
          </button>
        ),
      };
  return renderBannerSlot(pickBanner([offline, verify]));
}
