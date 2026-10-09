'use client';

import FileViewer from '@/retained/components/layout/middle-content/page-views/file/FileViewer';
import { usePageTree } from '@/retained/hooks/usePageTree';
import { findNodeAndParent } from '@/retained/lib/tree/tree-utils';
import { renderErrorState, renderLoadingState } from '@/ui/frame/edge-state/edge-state.render';

/** Classic's authorized tree DTO carries MIME/name metadata omitted by the page DTO. */
export default function RetainedFileView({ driveId, pageId }: { driveId: string; pageId: string }) {
  const { tree, isLoading, isError, retry } = usePageTree(driveId);
  if (isLoading) return renderLoadingState('Opening file…');
  const file = findNodeAndParent(tree, pageId)?.node;
  if (isError || !file) return renderErrorState({ title: 'Could not open this file', retry });
  return <FileViewer page={file} />;
}
