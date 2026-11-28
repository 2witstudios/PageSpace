'use client';

import { format } from 'date-fns';
import { Loader2, PanelLeft, RotateCcw, X } from 'lucide-react';
import Link from '@/retained-adapters/link';
import { Button } from '@/retained/components/ui/button';
import type { SnapshotPageNode } from '@/retained-adapters/ui-contracts';

export type SnapshotReaderProps = {
  readonly page: Pick<SnapshotPageNode, 'pageId' | 'title'> | null;
  readonly snapshotAt: string;
  readonly content: string | undefined;
  readonly loading: boolean;
  readonly restorable: boolean;
  readonly onRestore: () => void;
  readonly onClose: () => void;
  readonly showPaneToggle: boolean;
  readonly onShowPane: () => void;
};

/**
 * The middle column: "Nothing open" until a page is picked, then its read-only content from the snapshot
 * with the note that says it is a snapshot and links to the current version.
 */
export function SnapshotReader({ page, snapshotAt, content, loading, restorable, onRestore, onClose, showPaneToggle, onShowPane }: SnapshotReaderProps) {
  const when = format(new Date(snapshotAt), 'MMM d, yyyy h:mm a');
  const title = page?.title ?? 'Untitled';

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-12 flex-none items-center gap-1.5 border-b border-border pl-4 pr-2">
        {showPaneToggle && (
          <Button variant="ghost" size="icon" className="-ml-2 h-7 w-7" aria-label="Show sidebar" title="Show sidebar" onClick={onShowPane}>
            <PanelLeft className="h-4 w-4" />
          </Button>
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{page ? title : ''}</span>
        <Button size="sm" disabled={!restorable} onClick={onRestore}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          Restore from this snapshot
        </Button>
        {page && (
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close page" title="Close page" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {page === null ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Nothing open</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div role="note" className="sticky top-0 z-[2] flex items-center gap-2.5 border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            <span className="flex-1">
              Read-only — this is how <strong>{title}</strong> looked on {when}.
            </span>
            <Link href={`/p/${page.pageId}`} className="font-medium underline-offset-2 hover:underline">
              Open current version
            </Link>
          </div>
          <article className="mx-auto max-w-2xl px-8 py-12">
            <h1 className="mb-4 text-3xl font-bold tracking-tight">{title}</h1>
            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading content…</span>
              </div>
            ) : (
              <pre className="whitespace-pre-wrap font-sans text-base leading-relaxed">{content ?? '(No content)'}</pre>
            )}
          </article>
        </div>
      )}
    </main>
  );
}
