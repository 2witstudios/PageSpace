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
import { Download, MoreHorizontal, FileDown, Share2, Printer } from 'lucide-react';
import { isDocumentPage, isFilePage, isSheetPage } from '@pagespace/lib/client-safe';
import { ExportDropdown } from './ExportDropdown';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useMobile } from '@/hooks/useMobile';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { toast } from 'sonner';

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
  const [actionsSheetOpen, setActionsSheetOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
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

  const handleExportFromSheet = async (format: 'docx' | 'csv' | 'xlsx') => {
    if (!page) return;
    setActionsSheetOpen(false);
    try {
      const response = await fetchWithAuth(`/api/pages/${page.id}/export/${format}`);
      if (!response.ok) throw new Error(`Failed to export as ${format.toUpperCase()}`);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = `${page.title}.${format}`;
      window.document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      window.document.body.removeChild(a);
      toast.success(`Exported as ${format.toUpperCase()}`);
    } catch (error) {
      console.error(`Export error:`, error);
      toast.error(`Failed to export as ${format.toUpperCase()}`);
    }
  };

  // Mobile: single "..." button opens bottom sheet with all page actions
  if (isMobile) {
    const hasActions = pageIsDocument || pageIsSheet || pageIsFile;

    return (
      <div className="flex flex-col gap-1 p-2 border-b border-[var(--separator)]">
        <Breadcrumbs pageId={pageId} />
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <EditableTitle pageId={pageId} />
          </div>
          {hasActions && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 flex-shrink-0"
              onClick={() => setActionsSheetOpen(true)}
            >
              <MoreHorizontal className="h-5 w-5" />
            </Button>
          )}
        </div>

        <Sheet open={actionsSheetOpen} onOpenChange={setActionsSheetOpen}>
          <SheetContent
            side="bottom"
            className="rounded-t-2xl pb-[calc(1rem+env(safe-area-inset-bottom))]"
          >
            <SheetHeader className="px-5 pt-3 pb-0">
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" />
              <SheetTitle className="text-base">Actions</SheetTitle>
              <SheetDescription className="sr-only">Page actions</SheetDescription>
            </SheetHeader>

            <div className="px-5 pb-4 mt-2 space-y-1">
              {pageIsDocument && (
                <button
                  onClick={() => handleExportFromSheet('docx')}
                  className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors"
                >
                  <FileDown className="h-5 w-5 text-muted-foreground" />
                  <div className="text-left">
                    <div className="font-medium">Export as DOCX</div>
                    <div className="text-xs text-muted-foreground">Word document format</div>
                  </div>
                </button>
              )}
              {pageIsSheet && (
                <>
                  <button
                    onClick={() => handleExportFromSheet('csv')}
                    className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors"
                  >
                    <FileDown className="h-5 w-5 text-muted-foreground" />
                    <div className="text-left">
                      <div className="font-medium">Export as CSV</div>
                      <div className="text-xs text-muted-foreground">Comma-separated values</div>
                    </div>
                  </button>
                  <button
                    onClick={() => handleExportFromSheet('xlsx')}
                    className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors"
                  >
                    <FileDown className="h-5 w-5 text-muted-foreground" />
                    <div className="text-left">
                      <div className="font-medium">Export as Excel</div>
                      <div className="text-xs text-muted-foreground">Spreadsheet format</div>
                    </div>
                  </button>
                </>
              )}
              {(pageIsDocument || pageIsSheet) && (
                <button
                  onClick={() => { window.print(); setActionsSheetOpen(false); }}
                  className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors"
                >
                  <Printer className="h-5 w-5 text-muted-foreground" />
                  <div className="text-left">
                    <div className="font-medium">Print</div>
                    <div className="text-xs text-muted-foreground">Print this page</div>
                  </div>
                </button>
              )}

              {pageIsFile && (
                <button
                  onClick={() => { handleDownload(); setActionsSheetOpen(false); }}
                  disabled={isDownloading}
                  className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors disabled:opacity-50"
                >
                  <Download className="h-5 w-5 text-muted-foreground" />
                  <div className="text-left">
                    <div className="font-medium">{isDownloading ? 'Downloading...' : 'Download'}</div>
                    <div className="text-xs text-muted-foreground">Save file to device</div>
                  </div>
                </button>
              )}

              <div className="h-px bg-border my-2" />
              <button
                onClick={() => {
                  setActionsSheetOpen(false);
                  setTimeout(() => setShareDialogOpen(true), 200);
                }}
                className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors"
              >
                <Share2 className="h-5 w-5 text-muted-foreground" />
                <div className="text-left">
                  <div className="font-medium">Share</div>
                  <div className="text-xs text-muted-foreground">Manage permissions</div>
                </div>
              </button>
            </div>
          </SheetContent>
        </Sheet>

        <ShareDialog pageId={pageId} externalOpen={shareDialogOpen} onExternalOpenChange={setShareDialogOpen} />
        {children}
      </div>
    );
  }

  // Desktop layout
  return (
    <div className="flex flex-col gap-1 sm:gap-2 p-2 sm:p-4 border-b border-[var(--separator)]">
      <Breadcrumbs pageId={pageId} />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <EditableTitle pageId={pageId} />
          {(pageIsDocument || pageIsSheet) && (
            <SaveStatusIndicator isDirty={document?.isDirty || false} isSaving={isSaving} />
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {pageIsDocument && <EditorToggles />}
          {(pageIsDocument || pageIsSheet) && page && (
            <ExportDropdown pageId={page.id} pageTitle={page.title} pageType={page.type} />
          )}
          {pageIsFile && (
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
          <ShareDialog pageId={pageId} />
          {children}
        </div>
      </div>
    </div>
  );
}
