import type { Scale } from './onboarding-content';

/**
 * Step/draft state for the first-run flow, kept pure so the rules that are easy
 * to get wrong — what survives Back, what a scale change discards — are
 * testable without rendering anything.
 */

export const STEP_COUNT = 5;

/** Where a draft came from. A chip-filled draft is disposable; typing is not. */
export type DraftSource = 'user' | 'example';

export interface OnboardingState {
  step: number;
  scale: Scale | null;
  prompt: string;
  draftSource: DraftSource | null;
  submitted: boolean;
}

export type OnboardingAction =
  | { type: 'selectScale'; scale: Scale }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'setPrompt'; text: string; source: DraftSource }
  | { type: 'submit' };

export const initialOnboardingState: OnboardingState = {
  step: 0,
  scale: null,
  prompt: '',
  draftSource: null,
  submitted: false,
};

/** Can the flow advance from this step? */
export function canAdvance(state: OnboardingState): boolean {
  if (state.step === 0) return state.scale !== null;
  if (state.step === STEP_COUNT - 1) return state.prompt.trim() !== '';
  return true;
}

export function onboardingReducer(
  state: OnboardingState,
  action: OnboardingAction,
): OnboardingState {
  switch (action.type) {
    case 'selectScale': {
      if (state.scale === action.scale) return state;
      // A draft the user typed is theirs and survives; one that came from an
      // example chip belonged to the old scale's example set and would be
      // stale, so it goes. Discarding what someone typed because they adjusted
      // an earlier answer is the more annoying of the two failures.
      const keepDraft = state.draftSource === 'user';
      return {
        ...state,
        scale: action.scale,
        prompt: keepDraft ? state.prompt : '',
        draftSource: keepDraft ? state.draftSource : null,
      };
    }

    case 'next': {
      if (!canAdvance(state)) return state;
      return { ...state, step: Math.min(state.step + 1, STEP_COUNT - 1) };
    }

    case 'back':
      // Never destructive: the draft rides along, so stepping back to re-read a
      // screen costs nothing.
      return { ...state, step: Math.max(state.step - 1, 0) };

    case 'setPrompt':
      return { ...state, prompt: action.text, draftSource: action.source };

    case 'submit':
      if (state.prompt.trim() === '') return state;
      return { ...state, submitted: true };

    default:
      return state;
  }
}
