"use client";

import React, { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { Button } from '@/components/ui/button';
import type {
  ConflictResolutionChoice,
  DocumentConflict,
} from '@/lib/documents/conflict-resolution';

interface DocumentConflictBannerProps {
  conflict: DocumentConflict;
  contentMode?: 'html' | 'markdown';
  onResolve: (choice: ConflictResolutionChoice) => void;
  isResolving?: boolean;
}

/**
 * Persistent (never auto-dismissing) banner shown while a save conflict is
 * parked. It stays until the user picks a side — the local buffer is untouched
 * and autosave is paused for as long as it is visible.
 *
 * Both choices overwrite something, so the copy says so plainly and the parked
 * server copy is viewable inline: the user should be able to see the other
 * version before deciding, without leaving the editor. Deliberately makes no
 * promise about recovering the discarded side — page history is written on
 * every mutation but there is no UI or endpoint that lets a user restore it,
 * and the rows expire after 30 days.
 */
const DocumentConflictBanner = ({
  conflict,
  contentMode = 'html',
  onResolve,
  isResolving = false,
}: DocumentConflictBannerProps) => {
  const [showRemote, setShowRemote] = useState(false);

  // The parked copy is another user's content — sanitize before rendering it.
  const sanitizedRemote = useMemo(
    () => (contentMode === 'markdown' ? null : DOMPurify.sanitize(conflict.remoteContent)),
    [conflict.remoteContent, contentMode]
  );

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="document-conflict-banner"
      className="bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800 px-4 py-3"
    >
      <div className="max-w-4xl mx-auto flex flex-col gap-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="text-sm text-amber-900 dark:text-amber-100">
            <p className="font-medium">
              Someone else saved this document while you were editing it.
            </p>
            <p className="mt-0.5 text-amber-800 dark:text-amber-200">
              Your unsaved changes are still in the editor and have not been sent. Saving is
              paused until you choose. <strong>Keep mine</strong> replaces their version in the
              document; <strong>Use theirs</strong> discards your unsaved changes.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="default"
              disabled={isResolving}
              onClick={() => onResolve('keep-mine')}
            >
              Keep mine
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isResolving}
              onClick={() => onResolve('use-theirs')}
            >
              Use theirs
            </Button>
          </div>
        </div>

        <div>
          <button
            type="button"
            className="text-sm underline text-amber-900 dark:text-amber-100"
            aria-expanded={showRemote}
            onClick={() => setShowRemote((shown) => !shown)}
          >
            {showRemote ? 'Hide their version' : 'View their version'}
          </button>
          {showRemote && (
            <div
              data-testid="document-conflict-remote-preview"
              className="mt-2 max-h-64 overflow-auto rounded border border-amber-200 dark:border-amber-800 bg-background/60 p-3 text-sm"
            >
              {sanitizedRemote === null ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                  {conflict.remoteContent}
                </pre>
              ) : (
                <div
                  className="prose prose-sm dark:prose-invert max-w-none"
                  // Sanitized immediately above; this is another user's saved
                  // page content, rendered read-only for comparison.
                  dangerouslySetInnerHTML={{ __html: sanitizedRemote }}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DocumentConflictBanner;
