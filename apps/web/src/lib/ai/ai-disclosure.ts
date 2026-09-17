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

/**
 * Whether a channel or DM message could reach an AI agent. Agents are pages, and
 * a page mention (`@[Label](id:page)`) looks the same whatever the page type, so
 * any page mention counts — the disclosure is asked at most once per device.
 */
export const mayReachAiAgent = (content: string): boolean =>
  /@\[[^\]]{1,500}\]\([^:)]{1,200}:page\)/.test(content);
