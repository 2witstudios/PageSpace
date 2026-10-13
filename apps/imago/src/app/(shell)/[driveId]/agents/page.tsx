import { AgentsWorkspace } from '@/retained-adapters/agents-workspace';
import { getViewer } from '@/lib/auth/get-viewer';
export default async function AgentsPage({ params }: { params: Promise<{ driveId?: string }> }) {
await getViewer();
const { driveId } = await params;
return <AgentsWorkspace driveId={driveId} />;
}
