"use client";

import { useMemo, useRef } from 'react';
import useSWR from 'swr';
import { cn } from '@/lib/utils';
import { usePageTree } from '@/hooks/usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { PageType } from '@pagespace/lib/utils/enums';
import TerminalView from './page-views/terminal/TerminalView';
import {
  planMountedTerminals,
  collectTerminalPageIds,
} from './terminal-keepalive';

/** Default LRU bound: keep the 3 most-recent terminal subtrees alive. */
const MAX_MOUNTED_TERMINALS = 3;

const pageFetcher = (url: string) =>
  fetchWithAuth(url).then((r) => {
    if (!r.ok) throw new Error('Failed to fetch page');
    return r.json();
  });

interface TerminalKeepAliveHostProps {
  /** The active drive whose page tree we resolve terminal pages from. */
  driveId: string | undefined;
  /** The currently-active page id (may be any page type, or null). */
  activePageId: string | null;
}

/**
 * Keeps recently-visited TERMINAL page subtrees mounted across in-app
 * navigation, mirroring the GlobalAssistantView keep-mounted pattern in
 * CenterPanel. Tabbing back to a kept terminal is instant — the xterm buffer,
 * socket listeners, and workspace store all survive because the subtree never
 * unmounts; it is only CSS-hidden. Falling out of the bounded LRU (or trashing
 * the page) unmounts the subtree, which fires exactly one
 * `agent-terminal:disconnect` via XtermTerminal's own teardown.
 *
 * Nothing is mounted until a terminal page is actually visited, and terminals
 * are only ever added to the set while they are the active (visible) page — so
 * every xterm `open()`/`fit()` happens against a real, sized container.
 */
export default function TerminalKeepAliveHost({ driveId, activePageId }: TerminalKeepAliveHostProps) {
  const { tree } = usePageTree(driveId);

  // Resolve the active page from the tree. On fresh creation / deep links the
  // tree can lag (the page exists server-side but hasn't been merged in yet).
  // PageContent handles that with a direct /api/pages fetch; terminals must get
  // the same fallback or a just-created terminal would render blank until the
  // tree revalidates. Same SWR key as PageContent's fallback, so it's deduped
  // into a single request.
  const treeNode = useMemo(
    () => (activePageId ? findNodeAndParent(tree, activePageId) : null),
    [tree, activePageId],
  );
  const { data: fallbackPage } = useSWR<{ type?: string }>(
    activePageId && !treeNode ? `/api/pages/${activePageId}` : null,
    pageFetcher,
  );

  const currentTerminalId = useMemo(() => {
    if (!activePageId) return null;
    const type = treeNode?.node.type ?? fallbackPage?.type;
    return type === PageType.TERMINAL ? activePageId : null;
  }, [activePageId, treeNode, fallbackPage]);

  // Terminal ids present in the current drive's tree — drives eviction of
  // trashed/closed terminals. NOTE: this is per-drive, so switching drives
  // evicts (and disconnects) the previous drive's warm terminals — intentional,
  // so a terminal's PTY stream never leaks across drive contexts.
  const terminalIds = useMemo(() => collectTerminalPageIds(tree), [tree]);
  const validKey = useMemo(() => [...terminalIds].sort().join('|'), [terminalIds]);

  // Derive the mounted set synchronously (ref-backed LRU) so tabbing to a
  // terminal mounts it in the SAME render — no blank frame. planMountedTerminals
  // is idempotent for an unchanged `current` (already pinned to the front), so
  // recomputing under StrictMode's double-invoke yields the identical result.
  const lruRef = useRef<string[]>([]);
  const mounted = useMemo(() => {
    const next = planMountedTerminals({
      current: currentTerminalId,
      visited: lruRef.current,
      max: MAX_MOUNTED_TERMINALS,
      valid: new Set(terminalIds),
    });
    lruRef.current = next;
    return next;
    // validKey is the stable digest of terminalIds; currentTerminalId covers the
    // active pin. Together with the ref they fully determine `next`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTerminalId, validKey]);

  if (mounted.length === 0) return null;

  return (
    <>
      {mounted.map((id) => {
        const isVisible = id === currentTerminalId;
        return (
          <div
            key={`terminal-${id}`}
            className={cn(
              'absolute inset-0 z-10',
              isVisible ? 'flex flex-col' : 'hidden pointer-events-none',
            )}
            aria-hidden={!isVisible}
          >
            <TerminalView pageId={id} />
          </div>
        );
      })}
    </>
  );
}
