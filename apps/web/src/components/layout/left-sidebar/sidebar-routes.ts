import { sectionForPathname } from "@/lib/dashboard/focus";

/**
 * Which sidebar a pathname gets. One driveless destination (DMs) and two
 * focus sections swap the left sidebar; everything else falls through to the
 * drive's page tree (or the dashboard's Pulse / Favorites / Recents).
 *
 * A pure function rather than inline `if`s in `MemoizedSidebar` so the
 * matchers — the part with the actual edge cases — are testable without
 * rendering a sidebar.
 */

const DMS_PATH = /^\/dashboard\/dms(\/|$)/;

export type SidebarVariant = "dms" | "channels" | "agents" | "default";

export function resolveSidebarVariant(pathname: string): SidebarVariant {
  if (DMS_PATH.test(pathname)) return "dms";
  // Channels and Agents are focus sections, so both of their shapes — the
  // driveless global view and the drive-scoped one — come from the one
  // grammar, which is also what keeps `agents-archive` a plain page.
  const section = sectionForPathname(pathname);
  if (section === "channels") return "channels";
  if (section === "agents") return "agents";
  return "default";
}
