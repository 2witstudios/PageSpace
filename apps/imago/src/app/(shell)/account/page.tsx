import { getViewer } from '@/lib/auth/get-viewer';
import Settings from '@/retained/app/settings/page';
export default async function Page() { await getViewer(); return <Settings />; }
