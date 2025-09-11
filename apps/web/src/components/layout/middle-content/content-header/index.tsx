'use client';

import React, { useState } from 'react';
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
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import { PageType } from '@pagespace/lib/client';

interface ContentHeaderProps {
  children?: React.ReactNode;
}

export function ViewHeader({ children }: ContentHeaderProps = {}) {
  const params = useParams();
  const pageId = usePageStore((state) => state.pageId);
  const driveId = params.driveId as string;
  const { tree } = usePageTree(driveId);
  const [isDownloading, setIsDownloading] = useState(false);

  const pageResult = pageId ? findNodeAndParent(tree, pageId) : null;
  const page = pageResult?.node;

  const isDocumentPage = page?.type === PageType.DOCUMENT;
  const isFilePage = page?.type === PageType.FILE;

  const {
    document,
    isSaving,
  } = useDocument(page?.id || '', page?.content || '');

  // Handle file download
  const handleDownload = async () => {
    if (!page || !isFilePage) return;
    
    setIsDownloading(true);
    try {
      const response = await fetch(`/api/files/${page.id}/download`);
      if (!response.ok) {
        throw new Error('Failed to download file');
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = page.originalFileName || page.title;
      window.document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      window.document.body.removeChild(a);
    } catch (error) {
      console.error('Download error:', error);
    } finally {
      setIsDownloading(false);
    }
  };

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
          {isFilePage && (
            <Button
              onClick={handleDownload}
              disabled={isDownloading}
              variant="ghost"
              size="sm"
            >
              <Download className="mr-2 h-4 w-4" />
              {isDownloading ? 'Downloading...' : 'Download'}
            </Button>
          )}
          <ShareDialog />
          {children}
        </div>
      </div>
    </div>
  );
}

export default ViewHeader;