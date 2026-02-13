"use client";

import { useCallback, useState } from 'react';
import useSWR from 'swr';
import { Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useDocumentSaving } from '@/hooks/useDocument';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';

interface PageSetupButtonProps {
  pageId: string;
}

interface PageDetails {
  contentMode?: 'html' | 'markdown';
}

const fetcher = async (url: string): Promise<PageDetails> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch page details: ${response.status}`);
  }
  return response.json();
};

export function PageSetupButton({ pageId }: PageSetupButtonProps) {
  const [isConverting, setIsConverting] = useState(false);
  const { saveDocument } = useDocumentSaving(pageId);

  const { data: pageData, mutate } = useSWR(
    pageId ? `/api/pages/${pageId}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 300000,
    }
  );

  const contentMode = pageData?.contentMode === 'markdown' ? 'markdown' : 'html';
  const isDisabled = isConverting || !pageData;

  const handleModeChange = useCallback(async (nextMode: string) => {
    if (nextMode !== 'html' && nextMode !== 'markdown') {
      return;
    }

    if (nextMode === contentMode || isConverting) {
      return;
    }

    const confirmMessage = nextMode === 'markdown'
      ? 'Convert this page from Rich Text to Markdown?'
      : 'Convert this page from Markdown to Rich Text?';

    if (!window.confirm(confirmMessage)) {
      return;
    }

    setIsConverting(true);

    try {
      const doc = useDocumentManagerStore.getState().documents.get(pageId);
      if (doc?.isDirty) {
        if (doc.saveTimeout) {
          clearTimeout(doc.saveTimeout);
        }

        const saveResult = await saveDocument(doc.content);
        if (!saveResult) {
          toast.error('Please save your changes before converting');
          return;
        }
      }

      const response = await fetchWithAuth(`/api/pages/${pageId}/convert-content-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetMode: nextMode }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Conversion failed');
      }

      const result = await response.json();

      const store = useDocumentManagerStore.getState();
      store.updateDocument(pageId, {
        content: result.content,
        contentMode: result.contentMode,
        revision: result.revision,
        isDirty: false,
        lastSaved: Date.now(),
        lastUpdateTime: Date.now(),
      });

      await mutate();
      toast.success(`Converted to ${nextMode === 'markdown' ? 'Markdown' : 'Rich Text'}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Conversion failed');
    } finally {
      setIsConverting(false);
    }
  }, [contentMode, isConverting, mutate, pageId, saveDocument]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={isDisabled}
          aria-label="Page setup"
        >
          <Settings2 className="h-4 w-4 sm:mr-2" />
          <span className="hidden sm:inline">Page Setup</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Page Format</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={contentMode} onValueChange={handleModeChange}>
          <DropdownMenuRadioItem value="html" disabled={isDisabled}>
            Rich Text
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="markdown" disabled={isDisabled}>
            Markdown
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
