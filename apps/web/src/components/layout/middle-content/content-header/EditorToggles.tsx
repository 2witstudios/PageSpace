"use client";

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { useDocumentStore } from '@/stores/useDocumentStore';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { PageType, isDocumentPage, isCanvasPage } from '@pagespace/lib/client-safe';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useMobile } from '@/hooks/useMobile';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ArrowRightLeft } from 'lucide-react';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

export function EditorToggles() {
  const activeView = useDocumentStore((state) => state.activeView);
  const setActiveView = useDocumentStore((state) => state.setActiveView);
  const params = useParams();
  const pageId = params.pageId as string;
  const isMobile = useMobile();
  const { preferences } = useDisplayPreferences();
  const [isConverting, setIsConverting] = useState(false);

  // Fetch page data to determine type
  const { data: pageData, mutate } = useSWR(
    pageId ? `/api/pages/${pageId}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 300000,
    }
  );

  const contentMode = pageData?.contentMode || 'html';
  const isMarkdown = contentMode === 'markdown';

  const handleConvert = useCallback(async () => {
    const targetMode = isMarkdown ? 'html' : 'markdown';
    const confirmMessage = isMarkdown
      ? 'Convert this page from Markdown to Rich Text (HTML)?'
      : 'Convert this page from Rich Text (HTML) to Markdown?';

    if (!confirm(confirmMessage)) return;

    setIsConverting(true);
    try {
      const response = await fetchWithAuth(`/api/pages/${pageId}/convert-content-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetMode }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Conversion failed');
      }

      const result = await response.json();

      // Update local document store with converted content
      const store = useDocumentManagerStore.getState();
      store.updateDocument(pageId, {
        content: result.content,
        contentMode: result.contentMode,
        revision: result.revision,
        isDirty: false,
        lastSaved: Date.now(),
        lastUpdateTime: Date.now(),
      });

      // Revalidate SWR cache
      await mutate();

      toast.success(`Converted to ${targetMode === 'markdown' ? 'Markdown' : 'Rich Text'}`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setIsConverting(false);
    }
  }, [pageId, isMarkdown, mutate]);

  // Only show editor toggles if preference is enabled, for document/canvas pages, and not on mobile
  const pageType = pageData?.type as PageType;
  const isValidPageType = pageType && (isDocumentPage(pageType) || isCanvasPage(pageType));
  const shouldShowToggles = preferences.showCodeToggle && isValidPageType;

  if (!shouldShowToggles || isMobile) {
    return null;
  }

  const codeLabel = isMarkdown ? 'Markdown' : 'HTML';

  return (
    <div className="flex items-center gap-2">
      <Button
        variant={activeView === 'rich' ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setActiveView('rich')}
      >
        Rich
      </Button>
      <Button
        variant={activeView === 'code' ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setActiveView('code')}
      >
        {codeLabel}
      </Button>
      {isDocumentPage(pageType) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={isConverting}>
              <ArrowRightLeft className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleConvert} disabled={isConverting}>
              {isConverting
                ? 'Converting...'
                : isMarkdown
                  ? 'Convert to Rich Text (HTML)'
                  : 'Convert to Markdown'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
