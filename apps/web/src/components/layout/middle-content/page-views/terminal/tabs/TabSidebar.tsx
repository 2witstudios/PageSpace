"use client";

/**
 * The Machine page's inner-sidebar shell (Phase 4) — one component behind the
 * Terminal tab's session tree, the Code tab's file explorer and the Diff tab's
 * branch tree, so the three cannot drift apart in width, chrome or header
 * treatment again. They are the same component family; this is the family.
 *
 * It is also where narrow viewports are handled. A 16rem column beside a pane is
 * a desktop shape: on a phone it leaves the pane a sliver, and a Monaco editor or
 * an xterm in a sliver is worse than useless. So below the app's mobile
 * breakpoint the sidebar becomes a Sheet behind a header button and the pane gets
 * the full width — the same convention `Layout.tsx` already applies to the app's
 * own left/right sidebars, via the same `useMobile()` hook.
 *
 * The sidebar body is a RENDER PROP taking `close`, not a plain node, because the
 * sheet has to dismiss itself when a click NAVIGATES (picking a session, a
 * branch, a file) and must NOT when a click merely expands a tree row — only the
 * caller knows which of its clicks is which. On desktop `close` is a no-op, so
 * callers wire it unconditionally.
 */

import { useState, type ReactNode } from 'react';
import { PanelLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useMobile } from '@/hooks/useMobile';

export interface TabSidebarApi {
  /** Dismisses the sheet on narrow viewports; a no-op on desktop. Call it from a click that navigates, never from expand/collapse. */
  close: () => void;
}

interface TabSidebarProps {
  /** The sidebar's header label — "Sessions", "Code", "Branches". */
  title: string;
  /** What the sidebar shows. */
  children: (api: TabSidebarApi) => ReactNode;
  /** The tab's main pane, beside the sidebar on desktop and full-width under the header on narrow viewports. */
  pane: ReactNode;
}

const noop = () => {};
const DESKTOP_API: TabSidebarApi = { close: noop };

const HEADER_LABEL = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground';

export default function TabSidebar({ title, children, pane }: TabSidebarProps) {
  const isMobile = useMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  // The pane stays the SECOND child of the same outer div in both layouts, so
  // crossing the breakpoint reconciles it in place rather than remounting it —
  // a rotation mid-session must not tear down a live xterm or a mounted Monaco.
  // Only the first child changes type (aside <-> header bar), and rebuilding a
  // tree sidebar is cheap.
  return (
    <div className={isMobile ? 'flex h-full min-h-0 flex-col' : 'flex h-full min-h-0'}>
      {isMobile ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2">
                <PanelLeft className="size-4" />
                <span className={HEADER_LABEL}>{title}</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[85vw] max-w-sm gap-0 p-0">
              <SheetHeader className="shrink-0 border-b border-border px-3 py-2">
                <SheetTitle className={HEADER_LABEL}>{title}</SheetTitle>
                <SheetDescription className="sr-only">
                  {title} navigation for this Machine.
                </SheetDescription>
              </SheetHeader>
              <ScrollArea className="min-h-0 flex-1">{children({ close: () => setSheetOpen(false) })}</ScrollArea>
            </SheetContent>
          </Sheet>
        </div>
      ) : (
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-background">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
            <span className={HEADER_LABEL}>{title}</span>
          </div>
          <ScrollArea className="flex-1">{children(DESKTOP_API)}</ScrollArea>
        </aside>
      )}
      <div className="min-h-0 min-w-0 flex-1">{pane}</div>
    </div>
  );
}
