'use client';

import { useOnboardingGate } from './useOnboardingGate';
import { OnboardingModal } from './OnboardingModal';
import { dispatch, transactions } from '@/ui/store/transactions';

/**
 * First-run onboarding over Imago's chat home. Renders nothing until the
 * server has answered. Asking seeds the chat-home composer with the user's
 * first request (the existing draft transaction) and leaves sending to them.
 */
export function OnboardingGate() {
  const { status, complete } = useOnboardingGate();

  if (status !== 'show') return null;

  return (
    <OnboardingModal
      open
      onFinish={(input) => {
        void complete(input);
        if (input) dispatch(transactions.setChatDraft, input.firstRequest);
      }}
    />
  );
}
