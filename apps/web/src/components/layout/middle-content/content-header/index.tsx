'use client';

import React from 'react';
import { EditableTitle } from './EditableTitle';
import { Breadcrumbs } from './Breadcrumbs';
import { EditorToggles } from './EditorToggles';
import { SaveStatusIndicator } from './SaveStatusIndicator';
import { ShareDialog } from './page-settings/ShareDialog';
import { usePageTree } from '@/hooks/usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import { useParams } from 'next/navigation';
import { useDocument } from '@/hooks/useDocument';
import { usePageStore } from '@/hooks/usePage';

interface ContentHeaderProps {
  children?: React.ReactNode;
}

export function ViewHeader({ children }: ContentHeaderProps = {}) {
  const params = useParams();
  const pageId = usePageStore((state) => state.pageId);
  const driveId = params.driveId as string;
  const { tree } = usePageTree(driveId);

  const pageResult = pageId ? findNodeAndParent(tree, pageId) : null;
  const page = pageResult?.node;

  const isDocumentPage = page?.type === 'DOCUMENT';

  const {
    document,
    isSaving,
  } = useDocument(page?.id || '', page?.content || '');

  return (
    <div className="flex flex-col gap-2 p-4 border-b bg-card">
      <Breadcrumbs />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <EditableTitle />
          {isDocumentPage && <SaveStatusIndicator isDirty={document?.isDirty || false} isSaving={isSaving} />}
        </div>
        <div className="flex items-center gap-2">
          {isDocumentPage && <EditorToggles />}
          <ShareDialog />
          {children}
        </div>
      </div>
    </div>
  );
}

export default ViewHeader;