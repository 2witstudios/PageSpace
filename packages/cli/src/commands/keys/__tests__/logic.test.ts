import { describe, expect, it } from 'vitest';
import {
  allDrivesDowngradeConfirmMessage,
  availableMenuChoices,
  buildWizardScope,
  confirmMintMessage,
  driveMultiSelectOptions,
  driveRoleChoiceToScopeArg,
  driveTargetSelectOptions,
  keySelectOptions,
  menuSelectOptions,
  NON_INTERACTIVE_KEYS_MESSAGE,
  preselectedDriveIds,
  renderKeysTable,
  roleSelectOptions,
} from '../logic.js';
import type { KeySummary } from '../logic.js';

describe('availableMenuChoices', () => {
  it('offers create/list/edit/revoke/use/exit when at least one key exists', () => {
    expect(availableMenuChoices(1)).toEqual(['create', 'list', 'edit', 'revoke', 'use', 'exit']);
  });

  it('omits edit/revoke when there are zero keys — nothing to select', () => {
    expect(availableMenuChoices(0)).toEqual(['create', 'list', 'exit']);
  });
});

describe('menuSelectOptions', () => {
  it('maps each choice to a labeled select option, preserving order', () => {
    expect(menuSelectOptions(['create', 'exit'])).toEqual([
      { value: 'create', label: 'Create a new key' },
      { value: 'exit', label: 'Exit' },
    ]);
  });
});

describe('driveMultiSelectOptions', () => {
  it('maps drives to clack multiselect options, hinting the caller role', () => {
    expect(
      driveMultiSelectOptions([
        { id: 'drv1', name: 'Engineering', role: 'OWNER' },
        { id: 'drv2', name: 'Marketing', role: 'MEMBER' },
      ]),
    ).toEqual([
      { value: 'drv1', label: 'Engineering', hint: 'owner' },
      { value: 'drv2', label: 'Marketing', hint: 'member' },
    ]);
  });

  it('is a pure function: identical input produces a deep-equal result', () => {
    const drives = [{ id: 'drv1', name: 'Engineering', role: 'OWNER' as const }];
    expect(driveMultiSelectOptions(drives)).toEqual(driveMultiSelectOptions(drives));
  });
});

describe('roleSelectOptions', () => {
  it('always offers Member and Admin, plus one option per custom role', () => {
    expect(roleSelectOptions([{ id: 'role1', name: 'Reviewer' }])).toEqual([
      { value: { kind: 'member' }, label: 'Member' },
      { value: { kind: 'admin' }, label: 'Admin' },
      { value: { kind: 'custom', customRoleId: 'role1' }, label: 'Reviewer' },
    ]);
  });

  it('offers just Member/Admin when a drive defines no custom roles', () => {
    expect(roleSelectOptions([])).toEqual([
      { value: { kind: 'member' }, label: 'Member' },
      { value: { kind: 'admin' }, label: 'Admin' },
    ]);
  });
});

describe('driveRoleChoiceToScopeArg', () => {
  it('maps a member choice', () => {
    expect(driveRoleChoiceToScopeArg('drv1', { kind: 'member' })).toEqual({ id: 'drv1', role: 'MEMBER' });
  });

  it('maps an admin choice', () => {
    expect(driveRoleChoiceToScopeArg('drv1', { kind: 'admin' })).toEqual({ id: 'drv1', role: 'ADMIN' });
  });

  it('maps a custom-role choice', () => {
    expect(driveRoleChoiceToScopeArg('drv1', { kind: 'custom', customRoleId: 'role1' })).toEqual({
      id: 'drv1',
      role: null,
      customRoleId: 'role1',
    });
  });
});

describe('buildWizardScope', () => {
  it('builds a valid scope string from per-drive role selections, reusing buildTokenScope', () => {
    const result = buildWizardScope([
      { driveId: 'drv1', choice: { kind: 'member' } },
      { driveId: 'drv2', choice: { kind: 'admin' } },
    ]);
    expect(result).toEqual({ ok: true, scope: 'drive:drv1:member drive:drv2:admin offline_access' });
  });

  it('propagates buildTokenScope validation failures (e.g. zero drives selected)', () => {
    const result = buildWizardScope([]);
    expect(result.ok).toBe(false);
  });

  it('propagates a duplicate-drive validation failure', () => {
    const result = buildWizardScope([
      { driveId: 'drv1', choice: { kind: 'member' } },
      { driveId: 'drv1', choice: { kind: 'admin' } },
    ]);
    expect(result).toEqual({ ok: false, message: 'Duplicate --drive "drv1": each drive may only be scoped once.' });
  });

  it('builds "all_drives offline_access" when allDrives is true, ignoring any selections', () => {
    const result = buildWizardScope([], { allDrives: true });
    expect(result).toEqual({ ok: true, scope: 'all_drives offline_access' });
  });
});

describe('driveTargetSelectOptions', () => {
  it('offers "specific drives" and "all drives (unrestricted)" in that order', () => {
    expect(driveTargetSelectOptions()).toEqual([
      { value: 'specific', label: 'Choose specific drives' },
      { value: 'all', label: 'All drives (unrestricted) — maximum access, including drives created later' },
    ]);
  });
});

describe('confirmMintMessage', () => {
  it('echoes the raw scope string for a specific-drives mint', () => {
    expect(confirmMintMessage('drive:drv1:member offline_access', 'specific')).toBe(
      'Mint a new key scoped to: drive:drv1:member offline_access?',
    );
  });

  it('uses dedicated maximum-privilege copy for an all-drives mint, never the raw scope string', () => {
    const message = confirmMintMessage('all_drives offline_access', 'all');
    expect(message).toMatch(/ALL your drives/);
    expect(message).toMatch(/maximum-privilege/i);
    expect(message).not.toContain('all_drives offline_access');
  });
});

describe('allDrivesDowngradeConfirmMessage', () => {
  it('names the key and the drive count being narrowed to', () => {
    const message = allDrivesDowngradeConfirmMessage('God key', 2);
    expect(message).toContain('"God key"');
    expect(message).toMatch(/currently has access to ALL your drives/i);
    expect(message).toContain('2 drive(s)');
  });
});

const SAMPLE_KEYS: readonly KeySummary[] = [
  {
    id: 'tok1',
    name: 'CI bot',
    tokenPrefix: 'mcp_abcdefghijk',
    driveScopes: [{ id: 'drv1', name: 'Engineering' }],
    createdAt: '2026-07-01T00:00:00.000Z',
    lastUsed: null,
    isScoped: true,
  },
  {
    id: 'tok2',
    name: 'All-drives key',
    tokenPrefix: 'mcp_zzzzzzzzzzz',
    driveScopes: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    lastUsed: '2026-06-15T00:00:00.000Z',
    isScoped: false,
  },
];

describe('renderKeysTable', () => {
  it('renders each key as a short vertical block with date-only timestamps, blank-line separated', () => {
    expect(renderKeysTable(SAMPLE_KEYS)).toEqual([
      'CI bot  mcp_abcdefghijk',
      '  scopes: Engineering',
      '  created 2026-07-01 · last used never',
      '',
      'All-drives key  mcp_zzzzzzzzzzz',
      '  scopes: all drives',
      '  created 2026-06-01 · last used 2026-06-15',
    ]);
  });

  it('renders an orphaned key (isScoped: true, all its drives deleted) distinctly from an all-drives key', () => {
    const orphaned: KeySummary = {
      id: 'tok-orphan',
      name: 'Orphaned key',
      tokenPrefix: 'mcp_orphanorphan',
      driveScopes: [],
      createdAt: '2026-05-01T00:00:00.000Z',
      lastUsed: null,
      isScoped: true,
    };
    expect(renderKeysTable([orphaned])).toEqual([
      'Orphaned key  mcp_orphanorphan',
      '  scopes: NO ACCESS (orphaned)',
      '  created 2026-05-01 · last used never',
    ]);
  });

  it('summarizes long drive-scope lists instead of letting them wrap across lines', () => {
    const manyScopes: KeySummary = {
      id: 'tok3',
      name: 'Everything key',
      tokenPrefix: 'mcp_qqqqqqqqqqq',
      driveScopes: [
        { id: 'drv1', name: 'AIDD Agents' },
        { id: 'drv2', name: 'PageSpace' },
        { id: 'drv3', name: 'AI Agent Hub' },
        { id: 'drv4', name: 'Marketing' },
        { id: 'drv5', name: 'Engineering' },
      ],
      createdAt: '2026-04-30T16:15:07.553Z',
      lastUsed: '2026-07-06T09:00:00.000Z',
      isScoped: true,
    };
    expect(renderKeysTable([manyScopes])).toEqual([
      'Everything key  mcp_qqqqqqqqqqq',
      '  scopes: AIDD Agents, PageSpace, AI Agent Hub +2 more',
      '  created 2026-04-30 · last used 2026-07-06',
    ]);
  });

  it('renders a friendly single line when there are no keys', () => {
    expect(renderKeysTable([])).toEqual(['No keys found.']);
  });
});

describe('keySelectOptions', () => {
  it('maps keys to select options, hinting their drive scopes', () => {
    expect(keySelectOptions(SAMPLE_KEYS)).toEqual([
      { value: 'tok1', label: 'CI bot', hint: 'Engineering' },
      { value: 'tok2', label: 'All-drives key', hint: 'all drives' },
    ]);
  });

  it('prefixes the currently active key\'s hint with "active" when its id is known', () => {
    expect(keySelectOptions(SAMPLE_KEYS, 'tok1')).toEqual([
      { value: 'tok1', label: 'CI bot', hint: 'active · Engineering' },
      { value: 'tok2', label: 'All-drives key', hint: 'all drives' },
    ]);
  });

  it('marks nothing when the active key id is null or matches no listed key', () => {
    expect(keySelectOptions(SAMPLE_KEYS, null)).toEqual(keySelectOptions(SAMPLE_KEYS));
    expect(keySelectOptions(SAMPLE_KEYS, 'tok999')).toEqual(keySelectOptions(SAMPLE_KEYS));
  });

  it('distinguishes an orphaned key (isScoped: true, no surviving drives) from an all-drives key in the hint', () => {
    const orphaned: KeySummary = {
      id: 'tok-orphan',
      name: 'Orphaned key',
      tokenPrefix: 'mcp_orphanorphan',
      driveScopes: [],
      createdAt: '2026-05-01T00:00:00.000Z',
      lastUsed: null,
      isScoped: true,
    };
    expect(keySelectOptions([orphaned])).toEqual([{ value: 'tok-orphan', label: 'Orphaned key', hint: 'NO ACCESS (orphaned)' }]);
  });
});

describe('menuSelectOptions — the Set active key item', () => {
  it('labels the "use" choice as Set active key', () => {
    expect(menuSelectOptions(['use'])).toEqual([{ value: 'use', label: 'Set active key' }]);
  });
});

describe('preselectedDriveIds', () => {
  it('extracts the drive ids already scoped on a key, for pre-selecting the Edit multiselect', () => {
    expect(preselectedDriveIds(SAMPLE_KEYS[0])).toEqual(['drv1']);
  });

  it('is empty for an unscoped key', () => {
    expect(preselectedDriveIds(SAMPLE_KEYS[1])).toEqual([]);
  });
});

describe('NON_INTERACTIVE_KEYS_MESSAGE', () => {
  it('points a non-TTY caller at the flag-based subcommands', () => {
    expect(NON_INTERACTIVE_KEYS_MESSAGE).toContain('keys create');
    expect(NON_INTERACTIVE_KEYS_MESSAGE).toContain('keys list');
    expect(NON_INTERACTIVE_KEYS_MESSAGE).toContain('keys revoke');
  });
});
