import { describe, expect, it } from 'vitest';
import { confirmationFailureMessage, confirmDestructive, isYes } from '@pagespace/cli';

describe('isYes', () => {
  it('accepts y/yes case-insensitively, with surrounding whitespace', () => {
    expect(isYes('y')).toBe(true);
    expect(isYes('Y')).toBe(true);
    expect(isYes('yes')).toBe(true);
    expect(isYes('YES')).toBe(true);
    expect(isYes('  yes  ')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isYes('')).toBe(false);
    expect(isYes('n')).toBe(false);
    expect(isYes('no')).toBe(false);
    expect(isYes('yep')).toBe(false);
  });
});

describe('confirmDestructive', () => {
  it('succeeds immediately with --yes, never prompting', async () => {
    let prompted = false;
    const result = await confirmDestructive('Trash it?', {
      isTTY: false,
      yes: true,
      prompt: async () => {
        prompted = true;
        return 'yes';
      },
    });
    expect(result).toEqual({ ok: true });
    expect(prompted).toBe(false);
  });

  it('fails closed in a non-TTY session without --yes, never prompting', async () => {
    let prompted = false;
    const result = await confirmDestructive('Trash it?', {
      isTTY: false,
      yes: false,
      prompt: async () => {
        prompted = true;
        return 'yes';
      },
    });
    expect(result).toEqual({ ok: false, reason: 'non_tty_missing_yes' });
    expect(prompted).toBe(false);
  });

  it('prompts in a TTY session without --yes and succeeds on an affirmative answer', async () => {
    const result = await confirmDestructive('Trash it?', {
      isTTY: true,
      yes: false,
      prompt: async () => 'yes',
    });
    expect(result).toEqual({ ok: true });
  });

  it('prompts in a TTY session without --yes and fails on a declined answer', async () => {
    const result = await confirmDestructive('Trash it?', {
      isTTY: true,
      yes: false,
      prompt: async () => 'no',
    });
    expect(result).toEqual({ ok: false, reason: 'declined' });
  });

  it('supports a custom affirmative predicate (e.g. typed confirmation name)', async () => {
    const result = await confirmDestructive('Type the drive name to confirm:', {
      isTTY: true,
      yes: false,
      prompt: async () => 'My Drive',
      isAffirmative: (answer) => answer === 'My Drive',
    });
    expect(result).toEqual({ ok: true });
  });

  it('passes the exact message through to prompt', async () => {
    let seen: string | undefined;
    await confirmDestructive('Trash "Foo"?', {
      isTTY: true,
      yes: false,
      prompt: async (message) => {
        seen = message;
        return 'yes';
      },
    });
    expect(seen).toBe('Trash "Foo"?');
  });
});

describe('confirmationFailureMessage', () => {
  it('gives a --yes-pointing message for a non-TTY refusal', () => {
    expect(confirmationFailureMessage({ ok: false, reason: 'non_tty_missing_yes' })).toMatch(/--yes/);
  });

  it('gives an abort message for a declined interactive confirmation', () => {
    expect(confirmationFailureMessage({ ok: false, reason: 'declined' })).toMatch(/abort/i);
  });
});
