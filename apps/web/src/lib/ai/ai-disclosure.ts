/**
 * Disclosure that AI features share data with third-party AI providers
 * (App Review Guideline 5.1.2(i): disclose it and get permission before sending).
 *
 * Asked once per device, in the native apps. Storage failures read as "not yet
 * acknowledged" so the notice is shown again rather than skipped.
 */
export const AI_DISCLOSURE_STORAGE_KEY = 'ps_ai_disclosure_ack_v1';

export const needsAiDisclosure = ({ isNative, acknowledged }: { isNative: boolean; acknowledged: boolean }): boolean =>
  isNative && !acknowledged;

export function hasAcknowledgedAiDisclosure(): boolean {
  try {
    return window.localStorage.getItem(AI_DISCLOSURE_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function acknowledgeAiDisclosure(): void {
  try {
    window.localStorage.setItem(AI_DISCLOSURE_STORAGE_KEY, new Date().toISOString());
  } catch {
    // Unavailable storage: the notice is simply shown again next time.
  }
}
