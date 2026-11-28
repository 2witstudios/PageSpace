import type { Drive } from '@pagespace/lib/types';

/**
 * The drives the viewer owns that are in the trash, most recently trashed first. Only an owner can restore
 * or delete a drive, so trashed drives they do not own are not listed here.
 */
export const trashedDrivesOf = (drives: readonly Drive[], viewerId: string): readonly Drive[] =>
  drives
    .filter((drive) => drive.isTrashed && drive.ownerId === viewerId)
    .sort((a, b) => trashedTime(b) - trashedTime(a));

const trashedTime = (drive: Drive): number => (drive.trashedAt ? new Date(drive.trashedAt).getTime() || 0 : 0);

/** "Trashed 3 Oct 2026" as the row writes it; a missing or bad date reads as a dash. */
export const trashedLabel = (drive: Pick<Drive, 'trashedAt'>): string => {
  if (!drive.trashedAt) return 'Trashed —';
  const date = new Date(drive.trashedAt);
  return Number.isNaN(date.getTime()) ? 'Trashed —' : `Trashed ${date.toLocaleDateString()}`;
};

/**
 * Whether the typed text names the drive. The comparison ignores surrounding space and case, as the
 * drive dialog's own confirm does, and an empty name never matches.
 */
export const confirmMatches = (typed: string, driveName: string): boolean =>
  driveName !== '' && typed.trim().toLowerCase() === driveName.trim().toLowerCase();
