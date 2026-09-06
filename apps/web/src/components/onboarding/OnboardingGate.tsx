'use client';

import { useRouter } from 'next/navigation';
import { useOnboardingGate } from '@/hooks/useOnboardingGate';
import { OnboardingModal } from './OnboardingModal';

/**
 * Mount point for first-run onboarding.
 *
 * Renders nothing at all until the server has answered — see
 * `useOnboardingGate` for why "loading" must never be treated as "show".
 */
export function OnboardingGate() {
  const { status, complete } = useOnboardingGate();
  const router = useRouter();

  if (status !== 'show') return null;

  return (
    <OnboardingModal
      open
      onFinish={(input) => {
        void complete(input);
        if (!input) return;
        // Send the user to the global assistant, which is the only place the
        // queued request is consumed. Signup can land an invited user directly
        // on a page (`/dashboard/<driveId>/pages/<pageId>?welcome=true`), and
        // CenterPanel deliberately does not mount the assistant while a page is
        // active — so without this the request would sit queued and the user
        // would watch nothing happen.
        router.push('/dashboard');
      }}
    />
  );
}
