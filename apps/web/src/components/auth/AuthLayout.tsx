'use client';

import type { ReactNode } from 'react';
import { isV3AuthEnabled } from '@/lib/imago/v3-auth-enabled';
import { AuthShell } from './AuthShell';
import { AuthFrame } from './AuthFrame';

interface AuthLayoutProps {
  children: ReactNode;
  /** Shown as the "Signed in as" avatar in the v3 frame only. */
  signedInAs?: string;
  /**
   * What the classic (Imago off) branch wraps the page in: the AuthShell, or nothing for the pages
   * that never had a shell (activate, OAuth consent, provisioning, offline, unsubscribe), so their
   * classic look is unchanged.
   */
  classic?: 'shell' | 'bare';
}

/**
 * The single switch between the v3 AuthFrame (Imago enabled) and the classic AuthShell.
 * Every auth page renders through this so re-skins land in one place.
 */
export function AuthLayout({ children, signedInAs, classic = 'shell' }: AuthLayoutProps) {
  if (isV3AuthEnabled()) {
    return <AuthFrame {...(signedInAs && { signedInAs })}>{children}</AuthFrame>;
  }
  return classic === 'bare' ? <>{children}</> : <AuthShell>{children}</AuthShell>;
}
