'use client';

import AgentsSurface from '@/components/agents/AgentsSurface';

/**
 * The GLOBAL Agents console — every accessible drive's agents, grouped by drive
 * in the sidebar.
 *
 * A real view, not a redirect to a resolved drive: the driveless entry is the
 * global twin of `/dashboard/{driveId}/agents`, and redirecting would throw away
 * the cross-drive aggregation that is the whole reason it exists.
 *
 * No `layout.tsx` and no `[id]` segment anywhere under here. Selection is
 * `?agent=&c=` on THIS route, so there is no second route tree to keep in sync
 * and no route change to survive.
 */
export default function GlobalAgentsPage() {
  return <AgentsSurface />;
}
