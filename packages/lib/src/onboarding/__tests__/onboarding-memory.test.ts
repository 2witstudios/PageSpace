import { describe, expect, test, beforeEach, vi } from 'vitest';

const findFirst = vi.fn();
const setSpy = vi.fn();
const execute = vi.fn();
const getHomeDrive = vi.fn();
const provisionMemoryPages = vi.fn();

const tx = {
  execute: (...args: unknown[]) => execute(...args),
  query: { pages: { findFirst: (...args: unknown[]) => findFirst(...args) } },
  update: () => ({
    set: (values: { content?: string }) => {
      setSpy(values);
      return { where: () => Promise.resolve() };
    },
  }),
};

vi.mock('@pagespace/db/db', () => ({
  db: { transaction: (fn: (t: unknown) => unknown) => fn(tx) },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
}));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id' } }));
vi.mock('../../services/drive-service', () => ({
  getHomeDrive: (...args: unknown[]) => getHomeDrive(...args),
}));
vi.mock('../../memory/memory-pages', () => ({
  provisionMemoryPages: (...args: unknown[]) => provisionMemoryPages(...args),
}));

import { recordOnboardingContext } from '../onboarding-memory';

const CONTEXT = {
  scaleLabel: 'a small business or a tight team',
  firstRequest: 'Help me run my landscaping business',
};
const written = () => setSpy.mock.calls[0][0].content as string;

beforeEach(() => {
  vi.clearAllMocks();
  getHomeDrive.mockResolvedValue({ id: 'drive1' });
  provisionMemoryPages.mockResolvedValue({ bioPageId: 'bio1' });
  findFirst.mockResolvedValue({ content: '' });
});

describe('recordOnboardingContext', () => {
  test('writes what the user said into About You, so the "it remembers" promise is true', async () => {
    await expect(recordOnboardingContext('u1', CONTEXT)).resolves.toEqual({ written: true });
    expect(written()).toContain('Help me run my landscaping business');
    expect(written()).toContain('a small business or a tight team');
  });

  test('locks the page row so two concurrent completions cannot clobber each other', async () => {
    await recordOnboardingContext('u1', CONTEXT);
    // Without FOR UPDATE both requests read the same content and the later
    // whole-content write silently discards the earlier block.
    const locked = execute.mock.calls.some((call) =>
      JSON.stringify(call[0]?.strings ?? '').includes('FOR UPDATE'),
    );
    expect(locked).toBe(true);
  });

  test('preserves content the user or another agent already wrote', async () => {
    findFirst.mockResolvedValue({ content: '# About You\n\nI prefer blunt feedback.\n' });
    await recordOnboardingContext('u1', CONTEXT);
    expect(written()).toContain('I prefer blunt feedback.');
  });

  test('replaces its own previous block instead of stacking duplicates on a re-run', async () => {
    findFirst.mockResolvedValue({
      content:
        '<!-- pagespace:onboarding:start -->\n\n- What they came here to do: an older answer\n<!-- pagespace:onboarding:end -->\n',
    });
    await recordOnboardingContext('u1', CONTEXT);
    expect(written()).not.toContain('an older answer');
    expect(written().match(/pagespace:onboarding:start/g)).toHaveLength(1);
  });

  test('never eats user prose that merely starts with the same words', async () => {
    // The exact regression the delimiters exist for: a heading-prefix match
    // would delete from here to the next heading, taking the user's notes.
    findFirst.mockResolvedValue({
      content: '## From onboarding notes\n\nMy own notes about onboarding customers.\n',
    });
    await recordOnboardingContext('u1', CONTEXT);
    expect(written()).toContain('My own notes about onboarding customers.');
    expect(written()).toContain('## From onboarding notes');
  });

  test('leaves an unterminated marker alone rather than guessing where it ended', async () => {
    findFirst.mockResolvedValue({
      content: '<!-- pagespace:onboarding:start -->\n\nhand-edited, no end marker\n',
    });
    await recordOnboardingContext('u1', CONTEXT);
    expect(written()).toContain('hand-edited, no end marker');
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
