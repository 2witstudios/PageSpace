'use client';

import React from 'react';
import { PanelRight } from 'lucide-react';

interface OpenPagePaneRendererProps {
  pageId?: string;
  title?: string;
}

/**
 * A completed `open_page_pane` call. Informational only — nothing to click.
 *
 * Worded as a REQUEST ("Requested to open…"), never a confirmed outcome
 * ("Opened…"): the tool's own `execute` acks unconditionally because the
 * server has no visibility into any browser tab's pane-grid state (see
 * `page-pane-tools.ts`'s doc) — in a plain, session-less conversation (or
 * any surface with no mounted `useOpenPagePane`), this call is a genuine
 * no-op, and claiming "Opened" here would tell the user something happened
 * when nothing did.
 */
export function OpenPagePaneRenderer({ pageId, title }: OpenPagePaneRendererProps) {
  if (!pageId) return null;
  return (
    <div className="my-2 flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-sm">
      <PanelRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="text-muted-foreground">
        Requested to open <span className="font-medium text-foreground">{title ?? 'this page'}</span> in a pane
      </span>
    </div>
  );
}
