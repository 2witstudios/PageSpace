'use client';

import React, { memo, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import DOMPurify from 'dompurify';
import { FileEdit, ExternalLink, Plus, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { stripLineNumbers, escapeHtml, DIFF_STYLES } from './content-utils';

interface DiffChange {
  type: 'add' | 'remove' | 'unchanged';
  value: string;
}

interface RichDiffRendererProps {
  /** Page title for display */
  title: string;
  /** Original content before changes */
  oldContent: string;
  /** New content after changes */
  newContent: string;
  /** Page ID for navigation (optional) */
  pageId?: string;
  /** Summary of changes (e.g., "3 lines replaced") */
  changeSummary?: string;
  /** Maximum height before scrolling (default: 400px) */
  maxHeight?: number;
  /** Additional CSS class */
  className?: string;
}

/**
 * Simple diff algorithm using longest common subsequence approach
 * Returns an array of changes with type (add/remove/unchanged) and value
 */
function computeDiff(oldText: string, newText: string): DiffChange[] {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);

  const changes: DiffChange[] = [];

  // Build LCS table
  const m = oldWords.length;
  const n = newWords.length;
  const lcs: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }

  // Backtrack to find diff
  let i = m, j = n;
  const result: DiffChange[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      result.unshift({ type: 'unchanged', value: oldWords[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      result.unshift({ type: 'add', value: newWords[j - 1] });
      j--;
    } else if (i > 0) {
      result.unshift({ type: 'remove', value: oldWords[i - 1] });
      i--;
    }
  }

  // Merge consecutive changes of the same type
  for (const change of result) {
    const last = changes[changes.length - 1];
    if (last && last.type === change.type) {
      last.value += change.value;
    } else {
      changes.push({ ...change });
    }
  }

  return changes;
}

/**
 * RichDiffRenderer - Shows beautiful visual diffs of content changes
 *
 * Features:
 * - Visual diff with green highlights for additions, red for deletions
 * - Renders content as rich text, not code
 * - Clickable header to navigate to the page
 * - Shows change statistics
 * - Uses Tailwind dark mode for proper theme support
 */
export const RichDiffRenderer: React.FC<RichDiffRendererProps> = memo(function RichDiffRenderer({
  title,
  oldContent,
  newContent,
  pageId,
  changeSummary,
  maxHeight = 400,
  className
}) {
  const router = useRouter();

  // Process and compute diff
  const { diffHtml, stats } = useMemo(() => {
    // Strip line numbers if present
    const cleanOld = stripLineNumbers(oldContent || '');
    const cleanNew = stripLineNumbers(newContent || '');

    // Compute diff
    const changes = computeDiff(cleanOld, cleanNew);

    // Count additions and deletions
    let additions = 0;
    let deletions = 0;

    // Build HTML with diff highlighting using Tailwind classes
    const parts = changes.map(change => {
      const escapedValue = escapeHtml(change.value);
      const htmlValue = escapedValue.replace(/\n/g, '<br/>');

      switch (change.type) {
        case 'add':
          additions += change.value.length;
          return `<span class="${DIFF_STYLES.add}">${htmlValue}</span>`;
        case 'remove':
          deletions += change.value.length;
          return `<span class="${DIFF_STYLES.remove}">${htmlValue}</span>`;
        default:
          return htmlValue;
      }
    });

    return {
      diffHtml: parts.join(''),
      stats: { additions, deletions }
    };
  }, [oldContent, newContent]);

  const handleNavigate = () => {
    if (pageId) {
      router.push(`/p/${pageId}`);
    }
  };

  // Sanitize the diff HTML using allowlist approach
  const sanitizedHtml = useMemo(() => {
    if (typeof window === 'undefined') return diffHtml;
    return DOMPurify.sanitize(diffHtml, {
      ALLOWED_TAGS: ['span', 'br', 'p', 'div'],
      ALLOWED_ATTR: ['class'],
    });
  }, [diffHtml]);

  return (
    <div className={cn("rounded-lg border bg-card overflow-hidden my-2 shadow-sm", className)}>
      {/* Header - clickable to navigate */}
      <button
        onClick={handleNavigate}
        disabled={!pageId}
        className={cn(
          "w-full flex items-center justify-between px-3 py-2 bg-muted/30 border-b",
          "hover:bg-muted/50 transition-colors text-left",
          !pageId && "cursor-default"
        )}
      >
        <div className="flex items-center gap-2 overflow-hidden">
          <FileEdit className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate" title={title}>{title}</span>
          <span className="text-xs text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
            edited
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Change stats */}
          <div className="flex items-center gap-1.5 text-xs">
            {stats.additions > 0 && (
              <span className="flex items-center gap-0.5 text-green-600 dark:text-green-400">
                <Plus className="h-3 w-3" />
                {stats.additions}
              </span>
            )}
            {stats.deletions > 0 && (
              <span className="flex items-center gap-0.5 text-red-600 dark:text-red-400">
                <Minus className="h-3 w-3" />
                {stats.deletions}
              </span>
            )}
          </div>
          {pageId && (
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
        </div>
      </button>

      {/* Optional change summary */}
      {changeSummary && (
        <div className="px-3 py-1.5 bg-muted/20 border-b text-xs text-muted-foreground">
          {changeSummary}
        </div>
      )}

      {/* Content with diff highlighting */}
      <div
        className="bg-white dark:bg-gray-900 overflow-auto"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        <div
          className={cn(
            "p-4 text-gray-900 dark:text-gray-100 prose prose-sm max-w-none",
            "leading-relaxed whitespace-pre-wrap font-sans text-sm"
          )}
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
        />
      </div>
    </div>
  );
});
