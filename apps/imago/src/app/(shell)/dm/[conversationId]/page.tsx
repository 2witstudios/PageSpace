import { getViewer } from '@/lib/auth/get-viewer';
import DM from '@/retained/app/dashboard/dms/[conversationId]/page';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
export default async function Page() { await getViewer(); return <RetainedSurface><DM /></RetainedSurface>; }
