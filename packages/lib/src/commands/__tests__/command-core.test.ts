import { describe, it, expect } from 'vitest';
import {
  validateCommandTrigger,
  validateCommandDescription,
  isReservedTrigger,
  resolveCommandPrecedence,
  RESERVED_TRIGGERS,
  BUILTIN_COMMANDS,
  COMMAND_TRIGGER_MAX_LENGTH,
  COMMAND_DESCRIPTION_MAX_LENGTH,
  type CommandSummary,
} from '../command-core';

const userCmd = (trigger: string, overrides: Partial<CommandSummary> = {}): CommandSummary => ({
  id: `user-${trigger}`,
  trigger,
  description: `User command ${trigger}`,
  scope: 'user',
  type: 'document',
  ...overrides,
});

const driveCmd = (trigger: string, overrides: Partial<CommandSummary> = {}): CommandSummary => ({
  id: `drive-${trigger}`,
  trigger,
  description: `Drive command ${trigger}`,
  scope: 'drive',
  type: 'document',
  ...overrides,
});

const builtinCmd = (trigger: string): CommandSummary => ({
  id: `builtin-${trigger}`,
  trigger,
  description: `Built-in ${trigger}`,
  scope: 'builtin',
  type: 'builtin',
});

describe('validateCommandTrigger', () => {
  it.each(['design-review', 'a', 'pdf2', 'a-b-c', 'x1-y2', 'help'])(
    'accepts valid trigger %j',
    (trigger) => {
      expect(validateCommandTrigger(trigger)).toEqual({ valid: true });
    }
  );

  it('accepts a trigger of exactly 64 characters', () => {
    const trigger = 'a'.repeat(COMMAND_TRIGGER_MAX_LENGTH);
    expect(validateCommandTrigger(trigger)).toEqual({ valid: true });
  });

  it.each([
    ['uppercase', 'Design-Review'],
    ['all caps', 'HELP'],
    ['leading hyphen', '-design'],
    ['trailing hyphen', 'design-'],
    ['consecutive hyphens', 'design--review'],
    ['only a hyphen', '-'],
    ['empty string', ''],
    ['spaces', 'design review'],
    ['underscore', 'design_review'],
    ['unicode', 'desígn'],
    ['slash prefix', '/design'],
  ])('rejects %s (%j)', (_label, trigger) => {
    const result = validateCommandTrigger(trigger);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBeTruthy();
  });

  it('rejects a trigger longer than 64 characters', () => {
    const trigger = 'a'.repeat(COMMAND_TRIGGER_MAX_LENGTH + 1);
    const result = validateCommandTrigger(trigger);
    expect(result.valid).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(validateCommandTrigger(undefined).valid).toBe(false);
    expect(validateCommandTrigger(null).valid).toBe(false);
    expect(validateCommandTrigger(42).valid).toBe(false);
    expect(validateCommandTrigger({}).valid).toBe(false);
  });
});

describe('validateCommandDescription', () => {
  it('accepts a normal description', () => {
    expect(
      validateCommandDescription('Runs a design review. Use when reviewing UI changes.')
    ).toEqual({ valid: true });
  });

  it('accepts a single character', () => {
    expect(validateCommandDescription('x')).toEqual({ valid: true });
  });

  it('accepts exactly 1024 characters', () => {
    expect(validateCommandDescription('d'.repeat(COMMAND_DESCRIPTION_MAX_LENGTH))).toEqual({
      valid: true,
    });
  });

  it('rejects empty and whitespace-only descriptions', () => {
    expect(validateCommandDescription('').valid).toBe(false);
    expect(validateCommandDescription('   ').valid).toBe(false);
  });

  it('rejects descriptions longer than 1024 characters', () => {
    expect(
      validateCommandDescription('d'.repeat(COMMAND_DESCRIPTION_MAX_LENGTH + 1)).valid
    ).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(validateCommandDescription(undefined).valid).toBe(false);
    expect(validateCommandDescription(null).valid).toBe(false);
    expect(validateCommandDescription(7).valid).toBe(false);
  });
});

describe('RESERVED_TRIGGERS / isReservedTrigger', () => {
  it("contains 'help'", () => {
    expect(RESERVED_TRIGGERS.has('help')).toBe(true);
    expect(isReservedTrigger('help')).toBe(true);
  });

  it('does not reserve arbitrary triggers', () => {
    expect(isReservedTrigger('design-review')).toBe(false);
  });

  it('every built-in command trigger is reserved', () => {
    for (const builtin of BUILTIN_COMMANDS) {
      expect(RESERVED_TRIGGERS.has(builtin.trigger)).toBe(true);
    }
  });
});

describe('resolveCommandPrecedence', () => {
  it('returns all commands when there are no collisions', () => {
    const { winners, shadowed } = resolveCommandPrecedence(
      [builtinCmd('help')],
      [userCmd('mine')],
      [driveCmd('ours')]
    );
    expect(winners.map((w) => w.trigger).sort()).toEqual(['help', 'mine', 'ours']);
    expect(shadowed).toEqual([]);
    expect(winners.every((w) => w.shadows === undefined)).toBe(true);
  });

  it('builtin beats user and drive for the same trigger', () => {
    const { winners, shadowed } = resolveCommandPrecedence(
      [builtinCmd('help')],
      [userCmd('help')],
      [driveCmd('help')]
    );
    expect(winners).toHaveLength(1);
    expect(winners[0].scope).toBe('builtin');
    expect(shadowed.map((s) => s.scope).sort()).toEqual(['drive', 'user']);
  });

  it('user beats drive and the winner is marked with shadows: drive', () => {
    const { winners, shadowed } = resolveCommandPrecedence(
      [],
      [userCmd('deploy')],
      [driveCmd('deploy')]
    );
    expect(winners).toHaveLength(1);
    expect(winners[0].scope).toBe('user');
    expect(winners[0].shadows).toBe('drive');
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0].scope).toBe('drive');
    expect(shadowed[0].id).toBe('drive-deploy');
  });

  it('builtin winner over user is marked with shadows: user', () => {
    const { winners } = resolveCommandPrecedence([builtinCmd('help')], [userCmd('help')], []);
    expect(winners).toHaveLength(1);
    expect(winners[0].scope).toBe('builtin');
    expect(winners[0].shadows).toBe('user');
  });

  it('orders winners builtin first, then user, then drive', () => {
    const { winners } = resolveCommandPrecedence(
      [builtinCmd('help')],
      [userCmd('zz-user')],
      [driveCmd('aa-drive')]
    );
    expect(winners.map((w) => w.scope)).toEqual(['builtin', 'user', 'drive']);
  });

  it('does not mutate its inputs', () => {
    const user = [userCmd('deploy')];
    const drive = [driveCmd('deploy')];
    resolveCommandPrecedence([], user, drive);
    expect(user[0].shadows).toBeUndefined();
    expect(drive[0]).toEqual(driveCmd('deploy'));
  });

  it('handles empty inputs', () => {
    expect(resolveCommandPrecedence([], [], [])).toEqual({ winners: [], shadowed: [] });
  });
});
