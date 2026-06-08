'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import { ArrowLeft, File, FileCode, FileImage, FileSpreadsheet, FileText, Folder, BotMessageSquare, MessagesSquare, SquareCheckBig, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useDriveStore } from '@/hooks/useDrive';
import type { SnapshotPageNode } from '@/services/api/snapshot-pages-service';
import { formatSnapshotLabel, flattenTree, getNodeIcon } from './utils';

const ICON_COMPONENTS: Record<string, React.ComponentType<{ className?: string }>> = {
  FileText,
  FileCode,
  FileSpreadsheet,
  FileImage,
  File,
  Folder,
  MessagesSquare,
  BotMessageSquare,
  SquareCheckBig,
};

// ============================================================================
// Component
// ============================================================================

type BackupMeta = {
  id: string;
  label: string | null;
  source: string;
  status: string;
  createdAt: string;
};

type PagesResponse = {
  backup: BackupMeta;
  pages: SnapshotPageNode[];
};

const fetcher = async (url: string): Promise<PagesResponse> => {
  const r = await fetchWithAuth(url);
  if (!r.ok) throw new Error('Failed to load snapshot');
  return r.json();
};

export default function SnapshotPage({
  params,
}: {
  params: Promise<{ backupId: string }>;
}) {
  const router = useRouter();
  const driveId = useDriveStore((s) => s.currentDriveId);

  const [resolvedBackupId, setResolvedBackupId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<(SnapshotPageNode & { depth: number }) | null>(null);
  const [contentMap, setContentMap] = useState<Map<string, string>>(new Map());
  const [loadingContent, setLoadingContent] = useState(false);

  // Resolve async params on mount
  if (!resolvedBackupId) {
    params.then(({ backupId }) => setResolvedBackupId(backupId));
  }

  const swrKey = driveId && resolvedBackupId
    ? `/api/drives/${driveId}/backups/${resolvedBackupId}/pages`
    : null;

  const { data, isLoading, error, mutate } = useSWR<PagesResponse>(swrKey, fetcher, {
    revalidateOnFocus: false,
  });

  const handleRowClick = async (node: SnapshotPageNode & { depth: number }) => {
    setSelectedNode(node);
    if (contentMap.has(node.pageId)) return;
    if (!driveId || !resolvedBackupId) return;

    setLoadingContent(true);
    try {
      const r = await fetchWithAuth(
        `/api/drives/${driveId}/backups/${resolvedBackupId}/pages?includeContent=true`,
      );
      if (!r.ok) return;
      const result = (await r.json()) as PagesResponse;
      const newMap = new Map(contentMap);
      const flatten = (nodes: SnapshotPageNode[]): void => {
        for (const n of nodes) {
          if (n.content !== undefined) newMap.set(n.pageId, n.content);
          flatten(n.children);
        }
      };
      flatten(result.pages);
      setContentMap(newMap);
    } finally {
      setLoadingContent(false);
    }
  };

  if (!driveId || isLoading || !resolvedBackupId) {
    return (
      <div className="container max-w-4xl mx-auto py-10 px-10 flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="container max-w-4xl mx-auto py-10 px-10 flex flex-col items-center justify-center min-h-[400px] gap-4">
        <p className="text-muted-foreground">Failed to load snapshot</p>
        <Button variant="outline" onClick={() => mutate()}>Retry</Button>
      </div>
    );
  }

  if (!data) return null;

  const { backup, pages } = data;
  const flatNodes = flattenTree(pages);

  return (
    <div className="container max-w-5xl mx-auto py-10 px-10 space-y-6">
      <div>
        <Link href="/settings/backups">
          <Button variant="ghost" size="sm" className="mb-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Backups
          </Button>
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold">{formatSnapshotLabel(backup)}</h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge>{backup.status}</Badge>
            <Button
              size="sm"
              disabled={backup.status !== 'ready'}
              onClick={() => router.push(`/settings/backups?restore=${resolvedBackupId}`)}
            >
              Restore from this snapshot
            </Button>
          </div>
        </div>
      </div>

      <div className="flex gap-4">
        <div className={`flex-1 border rounded-lg overflow-hidden ${selectedNode ? 'max-w-[60%]' : ''}`}>
          <div className="divide-y">
            {flatNodes.length === 0 ? (
              <p className="text-sm text-muted-foreground p-4">No pages in this snapshot.</p>
            ) : (
              flatNodes.map((node) => {
                const iconName = getNodeIcon(node.type);
                const IconComp = ICON_COMPONENTS[iconName] ?? File;
                return (
                  <button
                    key={node.pageId}
                    className="w-full flex items-center gap-2 py-2 px-3 text-sm hover:bg-muted/50 text-left"
                    style={{ paddingLeft: `${12 + node.depth * 24}px` }}
                    onClick={() => handleRowClick(node)}
                  >
                    <IconComp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className={node.isTrashed ? 'line-through text-muted-foreground' : ''}>
                      {node.title ?? 'Untitled'}
                    </span>
                    {node.isTrashed && (
                      <Badge variant="outline" className="text-xs ml-1">Trashed</Badge>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {selectedNode && (
          <div className="flex-1 border rounded-lg flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-medium text-sm">{selectedNode.title ?? 'Untitled'}</span>
              <Button variant="ghost" size="sm" onClick={() => setSelectedNode(null)}>
                <X className="h-4 w-4" />
                Close
              </Button>
            </div>
            <div className="flex-1 p-4 overflow-auto">
              {loadingContent ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">Loading content…</span>
                </div>
              ) : (
                <pre className="text-sm whitespace-pre-wrap font-mono">
                  {contentMap.get(selectedNode.pageId) ?? '(No content)'}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
