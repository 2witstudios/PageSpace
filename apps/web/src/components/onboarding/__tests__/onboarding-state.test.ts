import { describe, expect, test } from 'vitest';
import {
  STEP_COUNT,
  canAdvance,
  initialOnboardingState,
  onboardingReducer,
  type OnboardingAction,
  type OnboardingState,
} from '../onboarding-state';

const run = (state: OnboardingState, ...actions: OnboardingAction[]) =>
  actions.reduce(onboardingReducer, state);

describe('advancing', () => {
  test('refuses to leave the first screen until a scale is chosen', () => {
    expect(canAdvance(initialOnboardingState)).toBe(false);
    expect(run(initialOnboardingState, { type: 'next' }).step).toBe(0);
  });

  test('advances once a scale is chosen', () => {
    const s = run(initialOnboardingState, { type: 'selectScale', scale: 'small' }, { type: 'next' });
    expect(s.step).toBe(1);
  });

  test('never advances past the last screen', () => {
    let s = run(initialOnboardingState, { type: 'selectScale', scale: 'solo' });
    for (let i = 0; i < STEP_COUNT + 3; i++) s = onboardingReducer(s, { type: 'next' });
    expect(s.step).toBe(STEP_COUNT - 1);
  });

  test('refuses to send an empty request', () => {
    const s = run(
      initialOnboardingState,
      { type: 'selectScale', scale: 'small' },
      { type: 'setPrompt', text: '   ', source: 'user' },
    );
    expect(canAdvance({ ...s, step: STEP_COUNT - 1 })).toBe(false);
    expect(onboardingReducer({ ...s, step: STEP_COUNT - 1 }, { type: 'submit' }).submitted).toBe(false);
  });
});

describe('going back is never destructive', () => {
  test('keeps what the user typed', () => {
    const s = run(
      initialOnboardingState,
      { type: 'selectScale', scale: 'small' },
      { type: 'next' },
      { type: 'setPrompt', text: 'run my bakery', source: 'user' },
      { type: 'back' },
      { type: 'next' },
    );
    expect(s.prompt).toBe('run my bakery');
  });

  test('never goes below the first screen', () => {
    expect(run(initialOnboardingState, { type: 'back' }, { type: 'back' }).step).toBe(0);
  });
});

describe('changing scale', () => {
  test('keeps a draft the user typed themselves', () => {
    const s = run(
      initialOnboardingState,
      { type: 'selectScale', scale: 'small' },
      { type: 'setPrompt', text: 'run my bakery', source: 'user' },
      { type: 'selectScale', scale: 'large' },
    );
    expect(s.prompt).toBe('run my bakery');
    expect(s.scale).toBe('large');
  });

  test('discards a draft that came from an example chip, because it belonged to the old scale', () => {
    const s = run(
      initialOnboardingState,
      { type: 'selectScale', scale: 'small' },
      { type: 'setPrompt', text: 'Get my team off Slack and organised', source: 'example' },
      { type: 'selectScale', scale: 'solo' },
    );
    expect(s.prompt).toBe('');
    expect(s.draftSource).toBeNull();
  });

  test('re-selecting the same scale changes nothing', () => {
    const before = run(
      initialOnboardingState,
      { type: 'selectScale', scale: 'mid' },
      { type: 'setPrompt', text: 'from a chip', source: 'example' },
    );
    expect(onboardingReducer(before, { type: 'selectScale', scale: 'mid' })).toBe(before);
  });
});
