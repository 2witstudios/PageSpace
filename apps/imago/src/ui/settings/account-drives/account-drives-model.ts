import type { Drive } from '@pagespace/lib/types';

export type DriveSortKey = 'name' | 'role' | 'lastAccessedAt' | 'createdAt';
export type DriveSortDirection = 'asc' | 'desc';
export type DriveSort = { readonly key: DriveSortKey; readonly direction: DriveSortDirection };

export const DEFAULT_SORT: DriveSort = { key: 'name', direction: 'asc' };

/** The header click: a new column sorts ascending; the sorted column flips its direction. */
export const nextSort = (current: DriveSort, key: DriveSortKey): DriveSort =>
  current.key === key
    ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: 'asc' };

const sortValue = (drive: Drive, key: DriveSortKey): string | number => {
  switch (key) {
    case 'name':
      return drive.name.toLowerCase();
    case 'role':
      return drive.role ?? '';
    case 'lastAccessedAt':
      return drive.lastAccessedAt ? new Date(drive.lastAccessedAt).getTime() : 0;
    case 'createdAt':
      return new Date(drive.createdAt).getTime();
  }
};

/** A copy of the drives in the sort's order. */
export const sortDrives = (drives: readonly Drive[], sort: DriveSort): readonly Drive[] => {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...drives].sort((a, b) => {
    const left = sortValue(a, sort.key);
    const right = sortValue(b, sort.key);
    if (left < right) return -sign;
    if (left > right) return sign;
    return 0;
  });
};

export type DriveGroup = { readonly label: string; readonly drives: readonly Drive[] };

/**
 * The table's groups: Favorites first, then the drives the viewer owns (Personal), then drives shared
 * with them. Trashed drives never appear here; the trash screen lists them. An empty group is left out.
 */
export const groupDrives = (drives: readonly Drive[], favoriteIds: ReadonlySet<string>, sort: DriveSort): readonly DriveGroup[] => {
  const active = drives.filter((drive) => !drive.isTrashed);
  const favorites = sortDrives(active.filter((drive) => favoriteIds.has(drive.id)), sort);
  const personal = sortDrives(active.filter((drive) => drive.isOwned && !favoriteIds.has(drive.id)), sort);
  const shared = sortDrives(active.filter((drive) => !drive.isOwned && !favoriteIds.has(drive.id)), sort);
  return [
    { label: 'Favorites', drives: favorites },
    { label: 'Personal', drives: personal },
    { label: 'Shared with you', drives: shared },
  ].filter((group) => group.drives.length > 0);
};

/** A role as the table writes it: "Owner", "Admin", "Member". */
export const roleLabel = (role: string | undefined): string =>
  role === undefined || role === '' ? '—' : role.charAt(0) + role.slice(1).toLowerCase();

/** Only an owner or an admin may rename or trash a drive, as the drive's own menu decides. */
export const canManageDrive = (drive: Pick<Drive, 'role'>): boolean => drive.role === 'OWNER' || drive.role === 'ADMIN';

export type DriveAction = 'open' | 'rename' | 'favorite' | 'trash';

/** The row menu's items for one drive: Open always, Rename and Move to trash only where the viewer may manage it. */
export const driveActionsOf = (drive: Pick<Drive, 'role'>, isFavorite: boolean): readonly { readonly action: DriveAction; readonly label: string }[] => [
  { action: 'open', label: 'Open' },
  ...(canManageDrive(drive) ? [{ action: 'rename' as const, label: 'Rename' }] : []),
  { action: 'favorite', label: isFavorite ? 'Unfavorite' : 'Favorite' },
  ...(canManageDrive(drive) ? [{ action: 'trash' as const, label: 'Move to trash' }] : []),
];

const dateLabel = (value: string | null | undefined): string => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
};

export const lastAccessedLabel = (drive: Pick<Drive, 'lastAccessedAt'>): string => dateLabel(drive.lastAccessedAt);
export const createdLabel = (drive: Pick<Drive, 'createdAt'>): string => dateLabel(drive.createdAt);
