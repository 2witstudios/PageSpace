import { describe, expect, test, beforeEach, vi } from 'vitest';

const findFirst = vi.fn();
const setSpy = vi.fn();
const getHomeDrive = vi.fn();
const provisionMemoryPages = vi.fn();

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { pages: { findFirst: (...args: unknown[]) => findFirst(...args) } },
    transaction: (fn: (tx: unknown) => unknown) => fn({}),
    update: () => ({
      set: (values: { content?: string }) => {
        setSpy(values);
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id' } }));
vi.mock('@pagespace/db/schema/personalization', () => ({ userPersonalization: {} }));
vi.mock('../../services/drive-service', () => ({
  getHomeDrive: (...args: unknown[]) => getHomeDrive(...args),
}));
vi.mock('../../memory/memory-pages', () => ({
  provisionMemoryPages: (...args: unknown[]) => provisionMemoryPages(...args),
}));

import { recordOnboardingContext } from '../onboarding-memory';

const CONTEXT = { scaleLabel: 'a small business or a tight team', firstRequest: 'Help me run my landscaping business' };

beforeEach(() => {
  vi.clearAllMocks();
  getHomeDrive.mockResolvedValue({ id: 'drive1' });
  provisionMemoryPages.mockResolvedValue({ bioPageId: 'bio1' });
  findFirst.mockResolvedValue({ content: '' });
});

describe('recordOnboardingContext', () => {
  test('writes what the user said into About You, so the "it remembers" promise is true', async () => {
    await expect(recordOnboardingContext('u1', CONTEXT)).resolves.toEqual({ written: true });
    const written = setSpy.mock.calls[0][0].content as string;
    expect(written).toContain('Help me run my landscaping business');
    expect(written).toContain('a small business or a tight team');
  });

  test('preserves content the user or another agent already wrote', async () => {
    findFirst.mockResolvedValue({ content: '# About You\n\nI prefer blunt feedback.\n' });
    await recordOnboardingContext('u1', CONTEXT);
    const written = setSpy.mock.calls[0][0].content as string;
    expect(written).toContain('I prefer blunt feedback.');
  });

  test('replaces its own previous block instead of stacking duplicates on a re-run', async () => {
    findFirst.mockResolvedValue({
      content: '## From onboarding\n\n- What they came here to do: an older answer\n',
    });
    await recordOnboardingContext('u1', CONTEXT);
    const written = setSpy.mock.calls[0][0].content as string;
    expect(written).not.toContain('an older answer');
    expect(written.match(/## From onboarding/g)).toHaveLength(1);
  });

  test('leaves later sections intact when replacing its own block', async () => {
    findFirst.mockResolvedValue({
      content: '## From onboarding\n\n- old\n\n## Written by the user\n\nkeep me\n',
    });
    await recordOnboardingContext('u1', CONTEXT);
    const written = setSpy.mock.calls[0][0].content as string;
    expect(written).toContain('keep me');
    expect(written).toContain('## Written by the user');
  });

  test('writes nothing when the request is blank rather than recording an empty promise', async () => {
    await expect(
      recordOnboardingContext('u1', { ...CONTEXT, firstRequest: '   ' }),
    ).resolves.toEqual({ written: false });
    expect(setSpy).not.toHaveBeenCalled();
  });

  test('writes nothing when the user has no Home drive rather than throwing mid-onboarding', async () => {
    getHomeDrive.mockResolvedValue(null);
    await expect(recordOnboardingContext('u1', CONTEXT)).resolves.toEqual({ written: false });
    expect(setSpy).not.toHaveBeenCalled();
  });
});
