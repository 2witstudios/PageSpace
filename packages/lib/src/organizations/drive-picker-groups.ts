/**
 * drive-picker-groups — the drive picker grouped by owner (Spec DRV-9; canvas v9 DrivePicker):
 * one header per organization the person belongs to, then Personal, from the SAME accessible-drives
 * list the picker already holds. It only regroups what it is given, so it can never show a drive
 * the person cannot open (A-4: Restricted drives are discovered in the org directory, not here).
 *
 * A drive of an org the person is NOT in (they are a guest on it, DRV-8) goes under "Shared with
 * you": its org's name is not theirs to see.
 *
 * PURE and client-safe.
 */

export interface PickerDrive {
  id: string;
  name: string;
  orgId?: string | null;
}

export interface PickerOrg {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

export type PickerGroup<D extends PickerDrive> =
  | { kind: 'org'; key: string; label: string; orgId: string; avatarUrl: string | null; role: PickerOrg['role']; drives: D[] }
  | { kind: 'personal'; key: 'personal'; label: 'Personal'; drives: D[] }
  | { kind: 'shared'; key: 'shared'; label: 'Shared with you'; drives: D[] };

const byName = (a: { name: string }, b: { name: string }) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());

export function groupPickerDrives<D extends PickerDrive>(drives: readonly D[], orgs: readonly PickerOrg[]): PickerGroup<D>[] {
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const inOrg = new Map<string, D[]>();
  const personal: D[] = [];
  const shared: D[] = [];
  for (const drive of drives) {
    if (!drive.orgId) personal.push(drive);
    else if (orgById.has(drive.orgId)) inOrg.set(drive.orgId, [...(inOrg.get(drive.orgId) ?? []), drive]);
    else shared.push(drive);
  }
  const groups: PickerGroup<D>[] = [...inOrg.entries()]
    .map(([orgId, list]) => {
      const org = orgById.get(orgId) as PickerOrg;
      return { kind: 'org' as const, key: `org:${orgId}`, label: org.name, orgId, avatarUrl: org.avatarUrl, role: org.role, drives: [...list].sort(byName) };
    })
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  if (personal.length > 0) groups.push({ kind: 'personal', key: 'personal', label: 'Personal', drives: [...personal].sort(byName) });
  if (shared.length > 0) groups.push({ kind: 'shared', key: 'shared', label: 'Shared with you', drives: [...shared].sort(byName) });
  return groups;
}
