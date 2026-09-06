import { describe, expect, test, beforeEach, vi } from 'vitest';

const findFirst = vi.fn();
const setSpy = vi.fn();
const whereSpy = vi.fn();

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { users: { findFirst: (...args: unknown[]) => findFirst(...args) } },
    update: () => ({
      set: (values: unknown) => {
        setSpy(values);
        return { where: (clause: unknown) => whereSpy(clause) };
      },
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ op: 'eq', field, value })),
  and: vi.fn((...clauses: unknown[]) => ({ op: 'and', clauses })),
  isNull: vi.fn((field: unknown) => ({ op: 'isNull', field })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', onboardingCompletedAt: 'onboardingCompletedAt' },
}));

import { hasCompletedOnboarding, markOnboardingComplete } from '../onboarding-state';
import { isNull } from '@pagespace/db/operators';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hasCompletedOnboarding', () => {
  test('reports not-completed when the stamp is null, so a new user sees the flow', async () => {
    findFirst.mockResolvedValue({ onboardingCompletedAt: null });
    await expect(hasCompletedOnboarding('u1')).resolves.toBe(false);
  });

  test('reports completed once a stamp exists, so a returning user never sees it again', async () => {
    findFirst.mockResolvedValue({ onboardingCompletedAt: new Date('2026-01-01') });
    await expect(hasCompletedOnboarding('u1')).resolves.toBe(true);
  });

  test('reports completed for an unresolvable user rather than onboarding a ghost', async () => {
    findFirst.mockResolvedValue(undefined);
    await expect(hasCompletedOnboarding('nobody')).resolves.toBe(true);
  });
});

describe('markOnboardingComplete', () => {
  test('writes a timestamp', async () => {
    await markOnboardingComplete('u1');
    expect(setSpy).toHaveBeenCalledWith({ onboardingCompletedAt: expect.any(Date) });
  });

  test('guards the write with IS NULL so a second call never moves the first completion', async () => {
    await markOnboardingComplete('u1');
    // The guard is the whole idempotency mechanism: without it, every dismissal
    // would rewrite the stamp and the recorded moment would be the LAST one.
    expect(isNull).toHaveBeenCalledWith('onboardingCompletedAt');
    expect(whereSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'and',
        clauses: expect.arrayContaining([
          expect.objectContaining({ op: 'isNull', field: 'onboardingCompletedAt' }),
        ]),
      }),
    );
  });
});
