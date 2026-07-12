import MachineView from '@/components/layout/middle-content/page-views/machine/MachineView';

/**
 * The Development surface's detail pane: the Machine page itself, reused
 * verbatim. A Machine's id IS its page id, so the route's `machineId` is
 * `MachineView`'s `pageId`.
 *
 * Only this segment re-renders as the user moves between machines —
 * `MemoizedSidebar` sits above the routed page, so the aggregated tree keeps its
 * expansion state (and its open terminal panes) across the navigation.
 */
export default async function DevelopmentMachinePage({
  params,
}: {
  params: Promise<{ driveId: string; machineId: string }>;
}) {
  const { machineId } = await params;

  return <MachineView pageId={machineId} />;
}
