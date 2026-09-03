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
 * `claim()` is deliberately take-once: it returns the pending request and
 * clears it in the same call, so a remount, a re-render, or a second consumer
 * can never re-send it. Sending a user's first request twice would be
 * duplicated work they pay for.
 */

import { create } from 'zustand';

interface OnboardingHandoffState {
  pendingRequest: string | null;
  /** Queue the first request for the assistant to pick up. */
  setPendingRequest: (request: string) => void;
  /** Take the pending request, clearing it. Returns null if there is none. */
  claim: () => string | null;
  /** Drop any pending request without sending it. */
  clear: () => void;
}

export const useOnboardingHandoffStore = create<OnboardingHandoffState>((set, get) => ({
  pendingRequest: null,

  setPendingRequest: (request: string) => {
    const trimmed = request.trim();
    if (!trimmed) return;
    set({ pendingRequest: trimmed });
  },

  claim: () => {
    const pending = get().pendingRequest;
    if (pending === null) return null;
    set({ pendingRequest: null });
    return pending;
  },

  clear: () => set({ pendingRequest: null }),
}));
