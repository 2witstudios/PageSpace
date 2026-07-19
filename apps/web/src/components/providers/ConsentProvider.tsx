'use client';

import { useEffect, useState } from 'react';
import { useConsentStore } from '@/stores/useConsentStore';
import { CookieBanner } from '@/components/consent/CookieBanner';

/**
 * Hydrates the consent store from the cookie on mount and renders the cookie banner
 * until the user has made an explicit decision. Thin shell — gating logic is pure
 * (see @pagespace/lib/consent + useConsentStore).
 */
function ConsentProvider() {
  const hydrate = useConsentStore((s) => s.hydrate);
  const showBanner = useConsentStore((s) => s.showBanner());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    hydrate();
    setHydrated(true);
  }, [hydrate]);

  // Avoid a hydration-mismatch flash: only decide visibility after reading the cookie.
  if (!hydrated || !showBanner) return null;

  return <CookieBanner />;
}

export default ConsentProvider;
