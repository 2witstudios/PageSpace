/**
 * Onboarding Handoff Store
 *
 * Carries the user's first request from the onboarding modal to the global
 * assistant, which is what turns the last screen from a form into the product's
 * actual loop.
 *
 * Why a store rather than a prop: GlobalAssistantView is mounted deep inside
 * CenterPanel and takes no props today. Threading one through would couple the
 * onboarding flow to the chat component tree; a store lets onboarding hand off
 * without importing any chat internals, and lets the assistant pick the request
 * up whenever it becomes ready rather than whenever onboarding happens to
 * render.
 *
 * Backed by sessionStorage, because the consumer is not always mounted when the
 * request is queued: a user invited straight to a page lands on a route where
 * CenterPanel deliberately does not mount the global assistant, and a refresh
 * there would otherwise drop an in-memory request while onboarding had already
 * been marked complete — losing it with no way to retry.
 *
 * `claim()` is deliberately take-once: it returns the pending request and
 * clears it in the same call, so a remount, a re-render, or a second consumer
 * can never re-send it. Sending a user's first request twice would be
 * duplicated work they pay for.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'pagespace:onboarding:pendingRequest';

/** sessionStorage throws in some privacy modes; never let that break onboarding. */
function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Ignored — the in-memory value still works for this page view.
  }
}

interface OnboardingHandoffState {
  pendingRequest: string | null;
  /** Queue the first request for the assistant to pick up. */
  setPendingRequest: (request: string) => void;
  /** Take the pending request, clearing it. Returns null if there is none. */
  claim: () => string | null;
  /** Put a claimed request back after a failed send, so it is not lost. */
  restore: (request: string) => void;
  /** Drop any pending request without sending it. */
  clear: () => void;
  /** Re-read sessionStorage into the store (after a reload). */
  hydrate: () => void;
}

export const useOnboardingHandoffStore = create<OnboardingHandoffState>((set, get) => ({
  pendingRequest: null,

  setPendingRequest: (request: string) => {
    const trimmed = request.trim();
    if (!trimmed) return;
    writeStored(trimmed);
    set({ pendingRequest: trimmed });
  },

  claim: () => {
    const pending = get().pendingRequest ?? readStored();
    if (pending === null) return null;
    writeStored(null);
    set({ pendingRequest: null });
    return pending;
  },

  restore: (request: string) => {
    const trimmed = request.trim();
    if (!trimmed) return;
    writeStored(trimmed);
    set({ pendingRequest: trimmed });
  },

  clear: () => {
    writeStored(null);
    set({ pendingRequest: null });
  },

  hydrate: () => {
    const stored = readStored();
    if (stored !== null && get().pendingRequest === null) set({ pendingRequest: stored });
  },
}));
