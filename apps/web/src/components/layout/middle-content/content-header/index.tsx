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
import { isDocumentPage, isFilePage, isSheetPage } from '@pagespace/lib/client-safe';
import { ExportDropdown } from './ExportDropdown';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useMobile } from '@/hooks/useMobile';

interface ContentHeaderProps {
  children?: React.ReactNode;
  pageId?: string | null;
}

export function ViewHeader({ children, pageId: propPageId }: ContentHeaderProps = {}) {
  const params = useParams();
  const storePageId = usePageStore((state) => state.pageId);
  const pageId = propPageId !== undefined ? propPageId : storePageId;
  const driveId = params.driveId as string;
  const { tree } = usePageTree(driveId);
  const [isDownloading, setIsDownloading] = useState(false);
  const isMobile = useMobile();

  const pageResult = pageId ? findNodeAndParent(tree, pageId) : null;
  const page = pageResult?.node;

  const pageIsDocument = page ? isDocumentPage(page.type) : false;
  const pageIsSheet = page ? isSheetPage(page.type) : false;
  const pageIsFile = page ? isFilePage(page.type) : false;

  const {
    document,
    isSaving,
  } = useDocument(page?.id || '');

  // Handle file download
  const handleDownload = async () => {
    if (!page || !pageIsFile) return;

    setIsDownloading(true);
    try {
      const response = await fetchWithAuth(`/api/files/${page.id}/download`);
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
    <div className="flex flex-col gap-1 sm:gap-2 p-2 sm:p-4 border-b border-[var(--separator)]">
      <Breadcrumbs pageId={pageId} />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <EditableTitle pageId={pageId} />
          {(pageIsDocument || pageIsSheet) && !isMobile && (
            <SaveStatusIndicator isDirty={document?.isDirty || false} isSaving={isSaving} />
          )}
        </div>
        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
          {pageIsDocument && <EditorToggles />}
          {(pageIsDocument || pageIsSheet) && page && (
            <ExportDropdown pageId={page.id} pageTitle={page.title} pageType={page.type} />
          )}
          {pageIsFile && (
            <Button
              onClick={handleDownload}
              disabled={isDownloading}
              variant="ghost"
              size={isMobile ? "icon" : "sm"}
            >
              <Download className={isMobile ? "h-4 w-4" : "mr-2 h-4 w-4"} />
              {!isMobile && (isDownloading ? 'Downloading...' : 'Download')}
            </Button>
          )}
          <ShareDialog pageId={pageId} />
          {children}
        </div>
      </div>
    </div>
  );
}