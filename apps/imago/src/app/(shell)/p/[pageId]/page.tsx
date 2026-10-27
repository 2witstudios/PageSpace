import { getHomeDrive } from '@pagespace/lib/services/drive-service';
import { getViewer } from '@/lib/auth/get-viewer';
import { PageResolver } from '@/retained-adapters/page-resolver';

export default async function Page({ params }: { params: Promise<{ pageId: string }> }) {
  const [{ pageId }, viewer] = await Promise.all([params, getViewer()]);
  const home = await getHomeDrive(viewer.userId);
  return <PageResolver pageId={pageId} homeDriveId={home?.id ?? null} />;
}
