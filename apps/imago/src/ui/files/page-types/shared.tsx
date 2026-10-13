'use client';

import { useCallback, useState } from 'react';
import { Download } from 'lucide-react';
import { SaveStatusIndicator } from '@/retained/components/layout/middle-content/content-header/SaveStatusIndicator';
import { Button } from '@/retained/components/ui/button';
import { useDocumentManagerStore } from '@/retained/stores/useDocumentManagerStore';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import type { TreePage } from '@/retained/hooks/usePageTree';

/** What every page-type module receives from the page view. */
export type PageTypeProps = { readonly page: TreePage; readonly driveId: string; readonly pageId: string };

/** Classic's header save status for one page, read from the same document store. */
export function SaveStatus({ pageId }: { readonly pageId: string }) {
  const isDirty = useDocumentManagerStore((state) => state.documents.get(pageId)?.isDirty ?? false);
  const isSaving = useDocumentManagerStore((state) => state.savingDocuments.has(pageId));
  return <SaveStatusIndicator isDirty={isDirty} isSaving={isSaving} />;
}

/**
 * A file's Download, as classic's header does it: the presigned URL as JSON first, then the
 * bytes without credentials (a credentialed redirect into the bucket fails CORS).
 */
export function DownloadFile({ page }: { readonly page: TreePage }) {
  const [busy, setBusy] = useState(false);
  const download = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetchWithAuth(`/api/files/${page.id}/download`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Failed to download file');
      const { url } = (await response.json()) as { url: string };
      const bytes = await fetch(url);
      if (!bytes.ok) throw new Error(`Failed to download file bytes: ${bytes.status}`);
      const href = window.URL.createObjectURL(await bytes.blob());
      const link = window.document.createElement('a');
      link.href = href;
      link.download = page.originalFileName || page.title;
      window.document.body.appendChild(link);
      link.click();
      window.URL.revokeObjectURL(href);
      link.remove();
    } finally {
      setBusy(false);
    }
  }, [page]);
  return (
    <Button onClick={() => void download()} disabled={busy} variant="ghost" size="sm">
      <Download className="mr-2 h-4 w-4" />
      {busy ? 'Downloading…' : 'Download'}
    </Button>
  );
}
