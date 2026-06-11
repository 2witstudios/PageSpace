import { describe, it, expect } from 'vitest';
import {
  sortByTrigger,
  toggleCommandInList,
  removeCommandFromList,
  upsertCommandInList,
  personalCommands,
  commandsForDrive,
  shadowedDriveNames,
  type CommandItem,
} from '../command-list-core';

const cmd = (overrides: Partial<CommandItem>): CommandItem => ({
  id: 'cmd_1',
  scope: 'user',
  driveId: null,
  trigger: 'foo',
  description: 'desc',
  entryPageId: 'p1',
  type: 'document',
  enabled: true,
  entryPageTitle: 'Page',
  entryPageDriveId: 'd1',
  entryPageAvailable: true,
  authorName: null,
  createdAt: '2026-06-09T00:00:00Z',
  updatedAt: '2026-06-09T00:00:00Z',
  ...overrides,
});

describe('sortByTrigger', () => {
  it('sorts alphabetically without mutating the input', () => {
    const list = [cmd({ id: 'b', trigger: 'zeta' }), cmd({ id: 'a', trigger: 'alpha' })];
    const sorted = sortByTrigger(list);
    expect(sorted.map((c) => c.trigger)).toEqual(['alpha', 'zeta']);
    expect(list[0].trigger).toBe('zeta');
  });
});

describe('optimistic list transforms', () => {
  it('toggleCommandInList flips only the target command', () => {
    const list = [cmd({ id: 'a' }), cmd({ id: 'b', trigger: 'bar' })];
    const next = toggleCommandInList(list, 'b', false);
    expect(next.find((c) => c.id === 'b')?.enabled).toBe(false);
    expect(next.find((c) => c.id === 'a')?.enabled).toBe(true);
    expect(list.find((c) => c.id === 'b')?.enabled).toBe(true);
  });

  it('removeCommandFromList drops the target', () => {
    const list = [cmd({ id: 'a' }), cmd({ id: 'b', trigger: 'bar' })];
    expect(removeCommandFromList(list, 'a').map((c) => c.id)).toEqual(['b']);
  });

  it('upsertCommandInList replaces an existing command and keeps trigger order', () => {
    const list = [cmd({ id: 'a', trigger: 'alpha' }), cmd({ id: 'b', trigger: 'zeta' })];
    const next = upsertCommandInList(list, cmd({ id: 'b', trigger: 'beta' }));
    expect(next.map((c) => c.trigger)).toEqual(['alpha', 'beta']);
  });

  it('upsertCommandInList inserts a new command in trigger order', () => {
    const list = [cmd({ id: 'a', trigger: 'alpha' }), cmd({ id: 'z', trigger: 'zeta' })];
    const next = upsertCommandInList(list, cmd({ id: 'm', trigger: 'mid' }));
    expect(next.map((c) => c.trigger)).toEqual(['alpha', 'mid', 'zeta']);
  });
});

describe('scope selectors', () => {
  const list = [
    cmd({ id: 'p', scope: 'user' }),
    cmd({ id: 'd1', scope: 'drive', driveId: 'drive_1', trigger: 'bar' }),
    cmd({ id: 'd2', scope: 'drive', driveId: 'drive_2', trigger: 'baz' }),
  ];

  it('personalCommands returns only user-scoped commands', () => {
    expect(personalCommands(list).map((c) => c.id)).toEqual(['p']);
  });

  it('commandsForDrive returns only the given drive', () => {
    expect(commandsForDrive(list, 'drive_2').map((c) => c.id)).toEqual(['d2']);
  });
});

describe('shadowedDriveNames (personal command shadowing drive commands)', () => {
  const list = [
    cmd({ id: 'd1', scope: 'drive', driveId: 'drive_1', trigger: 'foo' }),
    cmd({ id: 'd2', scope: 'drive', driveId: 'drive_2', trigger: 'foo' }),
    cmd({ id: 'd3', scope: 'drive', driveId: 'drive_3', trigger: 'other' }),
  ];
  const names = new Map([
    ['drive_1', 'Marketing'],
    ['drive_2', 'Engineering'],
  ]);

  it('lists names of drives whose commands collide with the trigger', () => {
    expect(shadowedDriveNames('foo', list, names)).toEqual(['Marketing', 'Engineering']);
  });

  it('falls back to the drive id when the name is unknown', () => {
    expect(
      shadowedDriveNames('other', list, names)
    ).toEqual(['drive_3']);
  });

  it('returns an empty array when nothing collides', () => {
    expect(shadowedDriveNames('nope', list, names)).toEqual([]);
  });
});
