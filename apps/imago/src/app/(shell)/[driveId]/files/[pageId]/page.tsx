import type { ReactNode } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';
import { PageObject } from '@/ui/files/page-object/page-object';
import { renderObjectPlaceholder } from '@/ui/frame/shell/object-placeholder';

type Props = { readonly params: Promise<{ driveId: string; pageId: string }> };

/**
 * Stage 3: tree, the open page and the fixed chat. The route renders only the
 * object slot's content, behind the gate that draws not-found for an id that
 * names no page of this drive the viewer can open.
 */
export default async function Page({ params }: Props): Promise<ReactNode> {
  const [{ driveId, pageId }] = await Promise.all([params, getViewer()]);
  return (
    <PageObject driveId={driveId} pageId={pageId}>
      {renderObjectPlaceholder('Page')}
    </PageObject>
  );
}
