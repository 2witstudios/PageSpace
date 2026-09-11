'use client';


import AgentsSurface from '@/components/agents/AgentsSurface';
import { focusDriveId, useFocus } from '@/lib/dashboard/focus';

/**
 * The drive-scoped Agents console — one drive's agents.
 *
 * A client component reading `useParams`, deliberately: Next 15 makes a server
 * page's `params` a Promise that must be awaited, and this surface is entirely
 * client state (selection lives in the query string, the tree is SWR). Awaiting
 * params server-side to hand a string to a client component would add a server
 * boundary that does nothing.
 */
export default function DriveAgentsPage() {
  const driveId = focusDriveId(useFocus());

  return <AgentsSurface driveId={driveId} />;
}
