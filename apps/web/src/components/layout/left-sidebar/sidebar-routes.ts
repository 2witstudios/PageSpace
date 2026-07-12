/**
 * Which sidebar a pathname gets. Each top-level nav destination that swaps the
 * left sidebar owns a matcher here; everything else falls through to the drive's
 * page tree.
 *
 * A pure function rather than inline `if`s in `MemoizedSidebar` so the matchers
 * — the part with the actual edge cases — are testable without rendering a
 * sidebar.
 */

const DMS_PATH = /^\/dashboard\/dms(\/|$)/;
const CHANNELS_PATH = /^\/dashboard\/channels(\/|$)/;
const DRIVE_CHANNELS_PATH = /^\/dashboard\/[^/]+\/channels(\/|$)/;
/**
 * ONE matcher for both Development shapes: the driveless entry
 * (`/dashboard/development`, which redirects) and the real drive-scoped tree
 * (`/dashboard/{driveId}/development[/{machineId}]`). The surface keeps the
 * drive in the path, so unlike Channels it needs no driveless twin.
 *
 * The optional drive segment is why this is anchored and segment-bounded: a
 * drive's ordinary page route (`/dashboard/{driveId}/{pageId}`) must not match.
 */
const DEVELOPMENT_PATH = /^\/dashboard\/(?:[^/]+\/)?development(\/|$)/;

export type SidebarVariant = 'dms' | 'channels' | 'development' | 'default';

export function resolveSidebarVariant(pathname: string): SidebarVariant {
  if (DMS_PATH.test(pathname)) return 'dms';
  if (CHANNELS_PATH.test(pathname) || DRIVE_CHANNELS_PATH.test(pathname)) return 'channels';
  if (DEVELOPMENT_PATH.test(pathname)) return 'development';
  return 'default';
}
