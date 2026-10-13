import { getViewer } from '@/lib/auth/get-viewer';
import { PageResolver } from '@/retained-adapters/page-resolver';

export default async function Page({ params }: { params: Promise<{ pageId: string }> }) {
  const [{ pageId }] = await Promise.all([params, getViewer()]);
  return <PageResolver pageId={pageId} />;
}
