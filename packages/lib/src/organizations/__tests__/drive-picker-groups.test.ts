import { describe, it, expect } from 'vitest';
import { groupPickerDrives } from '../drive-picker-groups';

const d = (id: string, name: string, orgId: string | null = null) => ({ id, name, orgId });
const orgs = [
  { id: 'o-northwind', name: 'Northwind Labs', avatarUrl: null, role: 'MEMBER' as const },
  { id: 'o-acme', name: 'Acme', avatarUrl: 'https://x/a.png', role: 'ADMIN' as const },
];

describe('groupPickerDrives: the drive picker by owner', () => {
  it('DRV-9 (partial) groups drives under each org header and a Personal group, orgs by name, drives by name', () => {
    const groups = groupPickerDrives([d('1', 'Product', 'o-northwind'), d('2', 'Home'), d('3', 'Design System', 'o-northwind'), d('4', 'Roadmap', 'o-acme')], orgs);
    expect(groups.map((g) => [g.kind, g.label, g.drives.map((x) => x.name)])).toEqual([
      ['org', 'Acme', ['Roadmap']],
      ['org', 'Northwind Labs', ['Design System', 'Product']],
      ['personal', 'Personal', ['Home']],
    ]);
    expect(groups[0]).toMatchObject({ orgId: 'o-acme', avatarUrl: 'https://x/a.png' });
  });

  it('DRV-9 (partial) the picker never shows a drive it was not given: grouping only regroups the accessible list', () => {
    const accessible = [d('1', 'Product', 'o-northwind'), d('2', 'Home')];
    const shown = groupPickerDrives(accessible, orgs).flatMap((g) => g.drives.map((x) => x.id)).sort();
    expect(shown).toEqual(['1', '2']);
  });

  it('DRV-8 (partial) a drive of an org the person is not in (a guest) sits under "Shared with you", never under that org\'s name', () => {
    const groups = groupPickerDrives([d('9', 'Partner brief', 'o-other'), d('2', 'Home')], orgs);
    expect(groups.map((g) => [g.kind, g.label])).toEqual([['personal', 'Personal'], ['shared', 'Shared with you']]);
    expect(groups.some((g) => g.kind === 'org')).toBe(false);
  });

  it('DRV-9 (partial) with no org drives there is one Personal group; empty input gives no groups', () => {
    expect(groupPickerDrives([d('2', 'Home')], orgs).map((g) => g.kind)).toEqual(['personal']);
    expect(groupPickerDrives([], orgs)).toEqual([]);
  });
});
