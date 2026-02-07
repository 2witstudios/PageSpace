'use client';

import React, { memo, useCallback, useMemo, useState } from 'react';
import { EditableTitle } from './EditableTitle';
import { Breadcrumbs } from './Breadcrumbs';
import { EditorToggles } from './EditorToggles';
import { SaveStatusIndicator } from './SaveStatusIndicator';
import { ShareDialog } from './page-settings/ShareDialog';
import { usePageTree } from '@/hooks/usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import { useParams } from 'next/navigation';
import { usePageStore } from '@/hooks/usePage';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import { isDocumentPage, isFilePage, isSheetPage } from '@pagespace/lib/client-safe';
import { ExportDropdown } from './ExportDropdown';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useMobile } from '@/hooks/useMobile';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';
import { usePagePresence } from '@/hooks/usePagePresence';
import { PageViewers } from '@/components/common/PageViewers';

interface ContentHeaderProps {
  children?: React.ReactNode;
  pageId?: string | null;
}

const DocumentSaveStatus = memo(function DocumentSaveStatus({
  pageId,
  enabled,
}: {
  pageId: string | null;
  enabled: boolean;
}) {
  const selectIsDirty = useCallback(
    (state: ReturnType<typeof useDocumentManagerStore.getState>) =>
      pageId ? state.documents.get(pageId)?.isDirty ?? false : false,
    [pageId]
  );
  const selectIsSaving = useCallback(
    (state: ReturnType<typeof useDocumentManagerStore.getState>) =>
      pageId ? state.savingDocuments.has(pageId) : false,
    [pageId]
  );

  const isDirty = useDocumentManagerStore(selectIsDirty);
  const isSaving = useDocumentManagerStore(selectIsSaving);

  if (!enabled || !pageId) {
    return null;
  }

  return <SaveStatusIndicator isDirty={isDirty} isSaving={isSaving} />;
});

export function ViewHeader({ children, pageId: propPageId }: ContentHeaderProps = {}) {
  const params = useParams();
  const storePageId = usePageStore((state) => state.pageId);
  const pageId = propPageId !== undefined ? propPageId : storePageId;
  const driveId = params.driveId as string;
  const { tree } = usePageTree(driveId);
  const [isDownloading, setIsDownloading] = useState(false);
  const isMobile = useMobile();

  const page = useMemo(() => {
    if (!pageId) {
      return null;
    }
    return findNodeAndParent(tree, pageId)?.node ?? null;
  }, [tree, pageId]);

  const pageIsDocument = page ? isDocumentPage(page.type) : false;
  const pageIsSheet = page ? isSheetPage(page.type) : false;
  const pageIsFile = page ? isFilePage(page.type) : false;
  const showSaveStatus = (pageIsDocument || pageIsSheet) && !isMobile;

  // Track and display presence (who else is viewing this page)
  usePagePresence(pageId);

  // Handle file download
  const handleDownload = useCallback(async () => {
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
  }, [page, pageIsFile]);

  return (
    <div className="flex flex-col gap-1 sm:gap-2 p-2 sm:p-4 border-b border-[var(--separator)]">
      <Breadcrumbs pageId={pageId} />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <EditableTitle pageId={pageId} />
          <DocumentSaveStatus pageId={page?.id ?? null} enabled={showSaveStatus} />
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
          <PageViewers pageId={pageId} />
          <ShareDialog pageId={pageId} />
          {children}
        </div>
      </div>
    </div>
  );
}
