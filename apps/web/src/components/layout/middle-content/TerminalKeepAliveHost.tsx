"use client";

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { usePageTree } from '@/hooks/usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import { PageType } from '@pagespace/lib/utils/enums';
import TerminalView from './page-views/terminal/TerminalView';
import {
  planMountedTerminals,
  collectTerminalPageIds,
} from './terminal-keepalive';

/** Default LRU bound: keep the 3 most-recent terminal subtrees alive. */
const MAX_MOUNTED_TERMINALS = 3;

interface TerminalKeepAliveHostProps {
  /** The active drive whose page tree we resolve terminal pages from. */
  driveId: string | undefined;
  /** The currently-active page id (may be any page type, or null). */
  activePageId: string | null;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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

  // Is the active page a terminal? If so it becomes the pinned "current".
  const currentTerminalId = useMemo(() => {
    if (!activePageId) return null;
    const found = findNodeAndParent(tree, activePageId);
    return found?.node.type === PageType.TERMINAL ? activePageId : null;
  }, [tree, activePageId]);

  // Stable key of all terminal ids present in the tree — drives eviction of
  // trashed/closed terminals without depending on the mounted set itself.
  const terminalIds = useMemo(() => collectTerminalPageIds(tree), [tree]);
  const validKey = useMemo(() => [...terminalIds].sort().join('|'), [terminalIds]);

  const [mounted, setMounted] = useState<string[]>([]);

  useEffect(() => {
    const valid = new Set(terminalIds);
    setMounted((prev) => {
      const next = planMountedTerminals({
        current: currentTerminalId,
        visited: prev,
        max: MAX_MOUNTED_TERMINALS,
        valid,
      });
      return arraysEqual(prev, next) ? prev : next;
    });
    // `terminalIds` intentionally excluded — `validKey` is its stable digest,
    // and `valid` is rebuilt from the current `terminalIds` inside the effect.
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
