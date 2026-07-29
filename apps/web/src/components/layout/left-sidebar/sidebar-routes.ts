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
 * ONE matcher for both Agents shapes: the driveless GLOBAL console
 * (`/dashboard/agents` — every accessible drive's agents, grouped by drive)
 * and the drive-scoped tree (`/dashboard/{driveId}/agents`).
 *
 * The matcher is anchored and segment-bounded: the optional drive segment
 * means a drive's ordinary page route (`/dashboard/{driveId}/{pageId}`) must
 * not match, and neither must a page literally named `agents-something`.
 */
const AGENTS_PATH = /^\/dashboard\/(?:[^/]+\/)?agents(\/|$)/;

export type SidebarVariant = 'dms' | 'channels' | 'agents' | 'default';

export function resolveSidebarVariant(pathname: string): SidebarVariant {
  if (DMS_PATH.test(pathname)) return 'dms';
  if (CHANNELS_PATH.test(pathname) || DRIVE_CHANNELS_PATH.test(pathname)) return 'channels';
  if (AGENTS_PATH.test(pathname)) return 'agents';
  return 'default';
}
