'use client';

import React from 'react';
import { PanelRight } from 'lucide-react';

interface OpenPagePaneRendererProps {
  pageId?: string;
  title?: string;
}

/**
 * A completed `open_page_pane` call. Informational only — nothing to click:
 * the pane (if this conversation is running inside a session's grid) already
 * opened as a side effect of the tool result streaming in, and the tool's own
 * `execute` never knows whether any browser tab actually had a grid to act on
 * (see `page-pane-tools.ts`'s doc).
 */
export function OpenPagePaneRenderer({ pageId, title }: OpenPagePaneRendererProps) {
  if (!pageId) return null;
  return (
    <div className="my-2 flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-sm">
      <PanelRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="text-muted-foreground">
        Opened <span className="font-medium text-foreground">{title ?? 'this page'}</span> in a pane
      </span>
    </div>
  );
}
