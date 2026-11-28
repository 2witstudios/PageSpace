'use client';

import { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { useApiClient } from '@/api/swr-provider';
import { ME, profileFrom } from '../avatar-menu/avatar-menu';
import { bannerActionClass } from './banner-slot.render';
import { bannerPriority, type Banner } from './banner-registry';

/** apps/web's resend route (apps/web/src/app/api/auth/resend-verification/route.ts). */
export const RESEND_VERIFICATION = '/api/auth/resend-verification';

/** Where the banner and the menu send the viewer to finish verifying. */
export const ACCOUNT_PROFILE = '/account/profile';

// "Sent" is shared by the banner and the account menu's row: one send, one copy.
let sentAt: number | null = null;
const listeners = new Set<() => void>();
const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
};
const isSent = (): boolean => sentAt !== null;
const markSent = (): void => {
  sentAt = Date.now();
  listeners.forEach((notify) => notify());
};

/** For tests: forget that a send happened. */
export const resetVerifyEmailSent = (): void => {
  sentAt = null;
  listeners.forEach((notify) => notify());
};

/**
 * The viewer's verification state and the resend action, shared by the shell's banner slot and
 * the account menu. Unverified means /api/auth/me says emailVerified is false; an unknown
 * profile is not treated as unverified.
 */
export function useVerifyEmail() {
  const client = useApiClient();
  const { data } = useSWR<unknown>(ME);
  const profile = profileFrom(data);
  const sent = useSyncExternalStore(subscribe, isSent, isSent);
  const [sending, setSending] = useState(false);

  const resend = async (): Promise<void> => {
    if (sending) return;
    setSending(true);
    try {
      await client.apiFetch(RESEND_VERIFICATION, { method: 'POST' });
      markSent();
      toast.success('Verification email sent successfully. Please check your inbox.');
    } catch {
      toast.error('We could not send the verification email. Try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  return { email: profile.email, unverified: profile.emailVerified === false, sent, sending, resend };
}

/** The verify-email banner for the shell's slot: null once verified or while the profile is unknown. */
export function useVerifyEmailBanner(): Banner | null {
  const { email, unverified, sent, sending, resend } = useVerifyEmail();
  if (!unverified) return null;
  return {
    id: 'verifyEmail',
    priority: bannerPriority.verifyEmail,
    tone: 'warning',
    message: sent ? (
      email === null ? 'Verification email sent! Please check your inbox.' : `Verification email sent! Please check your inbox at ${email}`
    ) : (
      'Verify your email to unlock all features — drive invitations, connection requests and direct messages.'
    ),
    actions: (
      <>
        {sent ? null : (
          <button type="button" className={bannerActionClass} onClick={() => void resend()} disabled={sending}>
            Resend Verification Email
          </button>
        )}
        <Link href={ACCOUNT_PROFILE} className={bannerActionClass}>
          Account settings
        </Link>
      </>
    ),
  };
}
