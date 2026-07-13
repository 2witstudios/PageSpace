"use client";

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { cn } from '@/lib/utils';
import { usePageTree } from '@/hooks/usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { PageType } from '@pagespace/lib/utils/enums';
import MachineView from './page-views/machine/MachineView';
import {
  planMountedMachines,
  collectMachinePageIds,
} from './machine-keepalive';

/** Default LRU bound: keep the 3 most-recent terminal subtrees alive. */
const MAX_MOUNTED_MACHINES = 3;

const pageFetcher = (url: string) =>
  fetchWithAuth(url).then((r) => {
    if (!r.ok) throw new Error('Failed to fetch page');
    return r.json();
  });

interface MachineKeepAliveHostProps {
  /** The active drive whose page tree we resolve terminal pages from. Ignored when `machineIds` is given. */
  driveId: string | undefined;
  /** The currently-active page id (may be any page type, or null). */
  activePageId: string | null;
  /**
   * Set by the Development surface, whose `machineIds`-driven caller already
   * shows every mounted `MachineView`'s workspace nav one level up (in
   * `DevelopmentSidebar`) — passed straight through to `MachineView` so its
   * Terminal tab skips its own, otherwise-redundant, inner sidebar. Unset (the
   * drive view's standalone Machine page) keeps it: there, the tree is the
   * ONLY workspace nav.
   */
  embedded?: boolean;
  /**
   * The drive's machine ids, when the caller already knows them.
   *
   * The drive view doesn't: any page can be active, so it has to ask the page
   * tree "is this one a MACHINE?" and which machines still exist. The
   * Development surface DOES — `/api/machines` is the list it renders — and
   * handing that list over here matters, because the two sources don't agree:
   * a machine present in `/api/machines` but missing from the tree (the tree
   * fetch failed, or a private machine granted through a custom drive role,
   * which the tree endpoint doesn't resolve) would be treated as trashed and
   * evicted from the LRU on the next machine switch — disconnecting a live
   * terminal, the exact thing this host exists to prevent.
   *
   * Passing it also skips the page-tree fetch (and the blank pane while it
   * loads) for a caller that has no other use for the tree.
   */
  machineIds?: readonly string[];
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
export default function MachineKeepAliveHost({ driveId, activePageId, machineIds: knownMachineIds, embedded = false }: MachineKeepAliveHostProps) {
  // A caller that supplied the machine list needs nothing from the tree, so the
  // tree isn't fetched at all (a null driveId is how usePageTree stays idle).
  const { tree, isLoading } = usePageTree(knownMachineIds ? undefined : driveId);

  // Resolve the active page from the tree. On fresh creation / deep links the
  // tree can lag (the page exists server-side but hasn't been merged in yet).
  // PageContent handles that with a direct /api/pages fetch; terminals must get
  // the same fallback or a just-created terminal would render blank until the
  // tree revalidates. Same SWR key and `!isLoading` gate as PageContent's
  // fallback, so it's deduped into a single request.
  const treeNode = useMemo(
    () => (activePageId ? findNodeAndParent(tree, activePageId) : null),
    [tree, activePageId],
  );
  const { data: fallbackPage } = useSWR<{ type?: string }>(
    !knownMachineIds && !isLoading && activePageId && !treeNode ? `/api/pages/${activePageId}` : null,
    pageFetcher,
  );

  const currentMachineId = useMemo(() => {
    if (!activePageId) return null;
    // A caller-supplied list is authoritative — no tree lookup, and so no blank
    // pane while the tree loads.
    if (knownMachineIds) return knownMachineIds.includes(activePageId) ? activePageId : null;
    const type = treeNode?.node.type ?? fallbackPage?.type;
    return type === PageType.MACHINE ? activePageId : null;
  }, [activePageId, knownMachineIds, treeNode, fallbackPage]);

  // Terminal ids present in the current drive's tree — drives eviction of
  // trashed/closed terminals. NOTE: this is per-drive, so switching drives
  // evicts (and disconnects) the previous drive's warm terminals — intentional,
  // so a terminal's PTY stream never leaks across drive contexts.
  const treeMachineIds = useMemo(() => collectMachinePageIds(tree), [tree]);
  const machineIds = knownMachineIds ?? treeMachineIds;
  const validKey = useMemo(() => [...machineIds].sort().join('|'), [machineIds]);

  // Derive the mounted LRU set synchronously so tabbing to a terminal mounts it
  // in the SAME render (no blank frame), using React's supported "adjust state
  // during render" pattern rather than a ref. State — unlike a ref — is
  // discarded when a concurrent render is abandoned, so an interrupted
  // navigation through a terminal page can't leave a never-committed terminal
  // mounted. `lru.key` guards against a re-render loop.
  const lruKey = `${currentMachineId ?? ''}\u0000${validKey}`;
  const [lru, setLru] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] });
  let mounted = lru.ids;
  if (lru.key !== lruKey) {
    mounted = planMountedMachines({
      current: currentMachineId,
      visited: lru.ids,
      max: MAX_MOUNTED_MACHINES,
      valid: new Set(machineIds),
    });
    setLru({ key: lruKey, ids: mounted });
  }

  if (mounted.length === 0) return null;

  return (
    <>
      {mounted.map((id) => {
        const isVisible = id === currentMachineId;
        return (
          <div
            key={`terminal-${id}`}
            className={cn(
              'absolute inset-0 z-10',
              isVisible ? 'flex flex-col' : 'hidden pointer-events-none',
            )}
            aria-hidden={!isVisible}
          >
            <MachineView pageId={id} embedded={embedded} />
          </div>
        );
      })}
    </>
  );
}
