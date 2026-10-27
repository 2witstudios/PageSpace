import { getViewer } from '@/lib/auth/get-viewer';
import { PageObject } from '@/ui/files/page-object/page-object';
import { PageView } from '@/ui/files/page-view/page-view';
export default async function Page({ params }: { params: Promise<{ driveId: string; pageId: string }> }) {
 const [{ driveId, pageId }] = await Promise.all([params, getViewer()]);
 return <PageObject driveId={driveId} pageId={pageId}><PageView driveId={driveId} pageId={pageId} /></PageObject>;
}
