'use client';

import { useState, useEffect } from 'react';
import { useRouter } from '@/retained-adapters/navigation';
import useSWR from 'swr';
import { Loader2 } from 'lucide-react';
import { Button } from '@/retained/components/ui/button';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import type { SnapshotPageNode } from '@/retained-adapters/ui-contracts';
import { flattenTree, type FlatSnapshotNode } from './utils';
import { SnapshotPane, type SnapshotMeta } from './SnapshotPane';
import { SnapshotReader } from './SnapshotReader';

// ============================================================================
// Component
// ============================================================================

type PagesResponse = {
  backup: SnapshotMeta & { id: string };
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
  const [resolvedBackupId, setResolvedBackupId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<FlatSnapshotNode | null>(null);
  const [contentMap, setContentMap] = useState<Map<string, string>>(new Map());
  const [loadingPageIds, setLoadingPageIds] = useState<Set<string>>(new Set());
  const [paneOpen, setPaneOpen] = useState(true);

  // Resolve async params on mount
  useEffect(() => {
    params.then(({ backupId }) => setResolvedBackupId(backupId));
  }, [params]);

  const swrKey = resolvedBackupId ? `/api/backups/${resolvedBackupId}/pages` : null;

  const { data, isLoading, error, mutate } = useSWR<PagesResponse>(swrKey, fetcher, {
    revalidateOnFocus: false,
  });

  const handleRowClick = async (node: FlatSnapshotNode) => {
    setSelectedNode(node);
    if (contentMap.has(node.pageId)) return;
    if (!resolvedBackupId) return;

    setLoadingPageIds(prev => new Set(prev).add(node.pageId));
    try {
      const r = await fetchWithAuth(
        `/api/backups/${resolvedBackupId}/pages?includeContent=true&pageId=${node.pageId}`,
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
      setLoadingPageIds(prev => { const s = new Set(prev); s.delete(node.pageId); return s; });
    }
  };

  if (isLoading || !resolvedBackupId) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Failed to load snapshot</p>
        <Button variant="outline" onClick={() => mutate()}>Retry</Button>
      </div>
    );
  }

  if (!data) return null;

  const { backup, pages } = data;

  return (
    <div className="flex h-full min-h-0">
      {paneOpen && (
        <SnapshotPane
          backup={backup}
          nodes={flattenTree(pages)}
          selectedPageId={selectedNode?.pageId ?? null}
          onSelect={handleRowClick}
          onClose={() => setPaneOpen(false)}
        />
      )}
      <SnapshotReader
        page={selectedNode}
        snapshotAt={backup.createdAt}
        content={selectedNode ? contentMap.get(selectedNode.pageId) : undefined}
        loading={selectedNode !== null && loadingPageIds.has(selectedNode.pageId)}
        restorable={backup.status === 'ready'}
        onRestore={() => router.push(`/settings/backups?restore=${resolvedBackupId}`)}
        onClose={() => setSelectedNode(null)}
        showPaneToggle={!paneOpen}
        onShowPane={() => setPaneOpen(true)}
      />
    </div>
  );
}
