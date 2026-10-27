import WorkspaceDetail from "@/components/fleet/WorkspaceDetail";

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ wsId: string }>;
}) {
  const { wsId } = await params;
  return <WorkspaceDetail wsId={wsId} />;
}
