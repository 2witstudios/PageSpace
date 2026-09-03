'use client';

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

  if (status !== 'show') return null;

  return <OnboardingModal open onFinish={(input) => void complete(input)} />;
}
