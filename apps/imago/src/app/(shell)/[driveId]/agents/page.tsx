import { AgentsWorkspace } from '@/retained-adapters/agents-workspace';
import { getViewer } from '@/lib/auth/get-viewer';
import { SectionScoped } from '@/ui/frame/drives/section-scoped';

export default async function AgentsPage({ params }: { params: Promise<{ driveId: string }> }) {
  await getViewer();
  const { driveId } = await params;
  return <SectionScoped section="agents" driveId={driveId} all={<AgentsWorkspace />} drive={<AgentsWorkspace driveId={driveId} />} />;
}
