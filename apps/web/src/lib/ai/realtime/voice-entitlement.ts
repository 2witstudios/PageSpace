import { PAID_TIERS } from '@/lib/subscription/rate-limit-middleware';

/**
 * Voice (a realtime call, a TTS synthesis) is a paid feature, and the tier that decides it is
 * the tier of whoever FUNDS the call (WAL-8): the org's inside an org drive, a personal drive
 * wallet's owner's, the caller's own on their own credits. One rule, one refusal, for both
 * voice routes.
 */
export function voiceEntitled(funderTier: string): boolean {
  return PAID_TIERS.has(funderTier);
}

/** The refusal body both voice routes answer (403) when the funder is not on a paid plan. */
export const VOICE_PLAN_REQUIRED = Object.freeze({
  error: 'Pro plan required',
  message: 'Voice mode requires a Pro or above subscription.',
  upgradeUrl: '/settings/plan',
});
