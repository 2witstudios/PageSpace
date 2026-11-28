'use client';
import { useState } from 'react';
import { History, X } from 'lucide-react';
import { Button } from '@/retained/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from '@/retained/components/ui/sheet';
import SidebarActivityTab from '@/retained/components/layout/right-sidebar/ai-assistant/SidebarActivityTab';

/**
 * "Version history" from the page "…" menu. Opens the Page history side sheet for this page:
 * search, All / AI changes, the retention meta and the expandable rows with undo / rollback.
 */
export function PageHistory({ pageId, pageTitle }: { readonly pageId: string; readonly pageTitle: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm" className="justify-start">
          Version history
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-label="Page history"
        className="w-[420px] max-w-full gap-0 p-0 sm:max-w-[420px]"
      >
        <div className="flex h-12 flex-none items-center gap-2 border-b pr-2 pl-4">
          <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <SheetTitle className="text-sm font-semibold">Page history</SheetTitle>
          <span className="max-w-[180px] truncate rounded-full bg-accent px-2 text-xs text-accent-foreground">
            {pageTitle}
          </span>
          <span className="flex-1" />
          <SheetClose asChild>
            <Button variant="ghost" size="icon" aria-label="Close page history" title="Close page history">
              <X aria-hidden="true" />
            </Button>
          </SheetClose>
        </div>
        <SidebarActivityTab pageId={pageId} />
      </SheetContent>
    </Sheet>
  );
}
