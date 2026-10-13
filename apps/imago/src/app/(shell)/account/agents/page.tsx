import { AgentsWorkspace } from '@/retained-adapters/agents-workspace';
import { getViewer } from '@/lib/auth/get-viewer';
export default async function AgentsPage() {
await getViewer();
const driveId = undefined;
return <AgentsWorkspace driveId={driveId} />;
}
