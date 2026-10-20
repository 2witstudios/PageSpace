import { AgentsWorkspace } from '@/retained-adapters/agents-workspace';
import { getViewer } from '@/lib/auth/get-viewer';
import { HomeScoped } from '@/ui/frame/drives/home-scoped';

export default async function AgentsPage({ params }: { params: Promise<{ driveId: string }> }) {
  await getViewer();
  const { driveId } = await params;
  return <HomeScoped driveId={driveId} home={<AgentsWorkspace />} drive={<AgentsWorkspace driveId={driveId} />} />;
}
