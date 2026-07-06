import { describe, expect, it } from 'vitest';
import {
  availableMenuChoices,
  buildWizardScope,
  driveMultiSelectOptions,
  driveRoleChoiceToScopeArg,
  keySelectOptions,
  menuSelectOptions,
  NON_INTERACTIVE_KEYS_MESSAGE,
  preselectedDriveIds,
  renderKeysTable,
  roleSelectOptions,
  shouldOfferRevokeOldKey,
} from '../logic.js';
import type { KeySummary } from '../logic.js';

describe('availableMenuChoices', () => {
  it('offers create/list/edit/revoke/exit when at least one key exists', () => {
    expect(availableMenuChoices(1)).toEqual(['create', 'list', 'edit', 'revoke', 'exit']);
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
});

const SAMPLE_KEYS: readonly KeySummary[] = [
  {
    id: 'tok1',
    name: 'CI bot',
    tokenPrefix: 'mcp_abcdefghijk',
    driveScopes: [{ id: 'drv1', name: 'Engineering' }],
    createdAt: '2026-07-01T00:00:00.000Z',
    lastUsed: null,
  },
  {
    id: 'tok2',
    name: 'Unscoped key',
    tokenPrefix: 'mcp_zzzzzzzzzzz',
    driveScopes: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    lastUsed: '2026-06-15T00:00:00.000Z',
  },
];

describe('renderKeysTable', () => {
  it('renders one readable line per key, including drive names and last-used', () => {
    const lines = renderKeysTable(SAMPLE_KEYS);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('CI bot');
    expect(lines[0]).toContain('mcp_abcdefghijk');
    expect(lines[0]).toContain('Engineering');
    expect(lines[1]).toContain('(unscoped)');
    expect(lines[1]).toContain('last used 2026-06-15T00:00:00.000Z');
  });

  it('renders a friendly single line when there are no keys', () => {
    expect(renderKeysTable([])).toEqual(['No keys found.']);
  });
});

describe('keySelectOptions', () => {
  it('maps keys to select options, hinting their drive scopes', () => {
    expect(keySelectOptions(SAMPLE_KEYS)).toEqual([
      { value: 'tok1', label: 'CI bot', hint: 'Engineering' },
      { value: 'tok2', label: 'Unscoped key', hint: 'unscoped' },
    ]);
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

describe('shouldOfferRevokeOldKey', () => {
  it('offers the revoke-old-key step only when the replacement mint succeeded', () => {
    expect(shouldOfferRevokeOldKey({ outcome: 'success' })).toBe(true);
  });

  it('never offers it when the mint failed for any reason', () => {
    expect(shouldOfferRevokeOldKey({ outcome: 'timeout' })).toBe(false);
    expect(shouldOfferRevokeOldKey({ outcome: 'access_denied' })).toBe(false);
  });
});

describe('NON_INTERACTIVE_KEYS_MESSAGE', () => {
  it('points a non-TTY caller at the flag-based subcommands', () => {
    expect(NON_INTERACTIVE_KEYS_MESSAGE).toContain('keys create');
    expect(NON_INTERACTIVE_KEYS_MESSAGE).toContain('keys list');
    expect(NON_INTERACTIVE_KEYS_MESSAGE).toContain('keys revoke');
  });
});
