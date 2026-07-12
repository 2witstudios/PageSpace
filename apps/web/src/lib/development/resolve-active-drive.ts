import type { Drive } from '@pagespace/lib/types';

/**
 * Which drive the driveless `/dashboard/development` entry should forward to.
 *
 * The Development surface keeps the drive in the path (one route tree), so its
 * driveless entry is a redirect rather than a second implementation. This is the
 * decision that redirect makes, extracted as a pure function so it's testable
 * without a router.
 *
 * The preference order is the app's existing one — the same
 * `find(currentDriveId) ?? first` fallback the backups settings page already
 * uses to pick a drive when the URL doesn't name one. `currentDriveId` is the
 * drive store's persisted "drive you were last in"; a trashed drive is never a
 * redirect target, including when it IS the last-visited one.
 *
 * Returns null when the user has no drive to go to — the caller sends them to
 * the drive picker instead.
 */
export function resolveActiveDriveId(drives: Drive[], currentDriveId: string | null): string | null {
  const candidates = drives.filter((drive) => !drive.isTrashed);
  const preferred = candidates.find((drive) => drive.id === currentDriveId);
  return (preferred ?? candidates[0])?.id ?? null;
}
