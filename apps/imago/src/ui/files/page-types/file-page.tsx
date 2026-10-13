'use client';

import dynamic from 'next/dynamic';
import useSWR from 'swr';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import { usePageTree } from '@/retained/hooks/usePageTree';
import { findNodeAndParent } from '@/retained/lib/tree/tree-utils';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { formatBytes } from '@/retained/lib/utils/utils';
import { DownloadFile, type PageTypeProps } from './shared';

const FileView = dynamic(() => import('@/retained-adapters/file-view'), { ssr: false });

/** The subset of GET /api/pages/[pageId]/processing-status this strip reads. */
type ProcessingStatus = { readonly status?: string | null };

const fetchProcessingStatus = async (url: string): Promise<ProcessingStatus> => {
  const response = await fetchWithAuth(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Failed to fetch processing status: ${response.status}`);
  return (await response.json()) as ProcessingStatus;
};

const POLL_MS = 3000;

/** Extraction state for the file: done, failed, or still in flight (polled until it settles). */
function ProcessingChip({ pageId }: { readonly pageId: string }) {
  const { data } = useSWR(`/api/pages/${pageId}/processing-status`, fetchProcessingStatus, {
    revalidateOnFocus: false,
    refreshInterval: (latest) => (latest?.status === 'completed' || latest?.status === 'failed' ? 0 : POLL_MS),
  });
  const status = data?.status;
  if (!status) return null;
  if (status === 'completed') {
    return (
      <span className="inline-flex h-6 items-center rounded-full bg-tint px-3 text-xs font-medium text-status-success">
        Text extracted · readable by AI
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex h-6 items-center rounded-full bg-tint px-3 text-xs font-medium text-status-danger">
        Processing failed
      </span>
    );
  }
  return (
    <span className="inline-flex h-6 items-center rounded-full bg-fill px-3 text-xs font-medium text-ink-muted">
      Processing…
    </span>
  );
}

/** A file in the v3 middle (C-Files-File): its 44px Page tools strip, then classic's viewer. */
export function FilePage({ page, driveId, pageId }: PageTypeProps) {
  // The page DTO omits MIME and size; the authorized tree DTO carries them (as file-view.tsx does).
  const { tree } = usePageTree(driveId);
  const file = findNodeAndParent(tree, pageId)?.node;
  const facts = [file?.mimeType, file?.fileSize != null ? formatBytes(file.fileSize) : null].filter(Boolean).join(' · ');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolbarStrip label="Page tools">
        <span className="text-xs text-ink-muted">{facts}</span>
        <div className="flex-1" />
        <ProcessingChip pageId={pageId} />
        <DownloadFile page={page} />
      </ToolbarStrip>
      <div className="min-h-0 flex-1">
        <FileView driveId={driveId} pageId={pageId} />
      </div>
    </div>
  );
}
