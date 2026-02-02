'use client';

import React, { memo, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import DOMPurify from 'dompurify';
import { FileEdit, ExternalLink, Plus, Minus, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { stripLineNumbers, markdownToHtml, DIFF_STYLES } from './content-utils';

interface LineDiff {
  type: 'add' | 'remove' | 'unchanged';
  oldLineNum?: number;
  newLineNum?: number;
  content: string;
}

interface ContextualRegion {
  type: 'hunk' | 'collapsed';
  lines?: LineDiff[];
  skippedCount?: number;
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
  /** Number of context lines to show around changes (default: 3) */
  contextLines?: number;
}

// Maximum lines for LCS matrix to prevent UI freezing
const MAX_DIFF_LINES = 2000;

/**
 * Compute line-based diff using LCS algorithm
 * Returns array of LineDiff with line numbers and change types
 */
function computeLineDiff(oldText: string, newText: string): LineDiff[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const m = oldLines.length;
  const n = newLines.length;

  // Guard: bail out for very large inputs
  if (m > MAX_DIFF_LINES || n > MAX_DIFF_LINES) {
    const result: LineDiff[] = [];
    oldLines.forEach((line, i) => {
      result.push({ type: 'remove', oldLineNum: i + 1, content: line });
    });
    newLines.forEach((line, i) => {
      result.push({ type: 'add', newLineNum: i + 1, content: line });
    });
    return result;
  }

  // Build LCS table for lines
  const lcs: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }

  // Backtrack to find line diff
  let i = m, j = n;
  const result: LineDiff[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({
        type: 'unchanged',
        oldLineNum: i,
        newLineNum: j,
        content: oldLines[i - 1]
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      result.unshift({
        type: 'add',
        newLineNum: j,
        content: newLines[j - 1]
      });
      j--;
    } else if (i > 0) {
      result.unshift({
        type: 'remove',
        oldLineNum: i,
        content: oldLines[i - 1]
      });
      i--;
    }
  }

  return result;
}

/**
 * Extract contextual regions (hunks) from line diff
 * Groups changes with surrounding context lines, merges overlapping hunks
 */
function extractContextualRegions(
  lineDiff: LineDiff[],
  contextLines: number
): ContextualRegion[] {
  if (lineDiff.length === 0) return [];

  // Find indices of changed lines
  const changedIndices: number[] = [];
  lineDiff.forEach((line, idx) => {
    if (line.type !== 'unchanged') {
      changedIndices.push(idx);
    }
  });

  // If no changes, show collapsed indicator for entire document
  if (changedIndices.length === 0) {
    return lineDiff.length > 0
      ? [{ type: 'collapsed', skippedCount: lineDiff.length }]
      : [];
  }

  // Build ranges with context (start, end inclusive)
  const ranges: Array<{ start: number; end: number }> = [];

  for (const idx of changedIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(lineDiff.length - 1, idx + contextLines);

    // Try to merge with previous range if overlapping or adjacent
    const lastRange = ranges[ranges.length - 1];
    if (lastRange && start <= lastRange.end + 1) {
      lastRange.end = Math.max(lastRange.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  // Convert ranges to regions with collapsed indicators
  const regions: ContextualRegion[] = [];
  let lastEnd = -1;

  for (const range of ranges) {
    // Add collapsed indicator for skipped lines before this range
    const skippedBefore = range.start - lastEnd - 1;
    if (skippedBefore > 0) {
      regions.push({ type: 'collapsed', skippedCount: skippedBefore });
    }

    // Add the hunk
    regions.push({
      type: 'hunk',
      lines: lineDiff.slice(range.start, range.end + 1)
    });

    lastEnd = range.end;
  }

  // Add collapsed indicator for remaining lines after last range
  const skippedAfter = lineDiff.length - 1 - lastEnd;
  if (skippedAfter > 0) {
    regions.push({ type: 'collapsed', skippedCount: skippedAfter });
  }

  return regions;
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
  className,
  contextLines = 3
}) {
  const router = useRouter();

  // Process and compute contextual diff
  const { regions, stats } = useMemo(() => {
    // Strip line numbers if present
    const cleanOld = stripLineNumbers(oldContent || '');
    const cleanNew = stripLineNumbers(newContent || '');

    // Compute line-based diff
    const lineDiff = computeLineDiff(cleanOld, cleanNew);

    // Count additions and deletions (by lines)
    let additions = 0;
    let deletions = 0;
    for (const line of lineDiff) {
      if (line.type === 'add') additions++;
      if (line.type === 'remove') deletions++;
    }

    // Extract contextual regions
    const contextualRegions = extractContextualRegions(lineDiff, contextLines);

    return {
      regions: contextualRegions,
      stats: { additions, deletions }
    };
  }, [oldContent, newContent, contextLines]);

  const handleNavigate = () => {
    if (pageId) {
      router.push(`/p/${pageId}`);
    }
  };

  // Render a collapsed indicator
  const renderCollapsed = (skippedCount: number, key: string) => (
    <div
      key={key}
      className="flex items-center gap-2 py-1.5 px-3 text-xs text-muted-foreground bg-muted/30 border-y border-dashed border-muted"
    >
      <MoreHorizontal className="h-3 w-3" />
      <span>{skippedCount} unchanged {skippedCount === 1 ? 'line' : 'lines'}</span>
    </div>
  );

  // Render a hunk with its lines
  const renderHunk = (lines: LineDiff[], key: string) => {
    const htmlParts = lines.map((line, idx) => {
      const lineKey = `${key}-line-${idx}`;
      // Convert markdown to HTML for rich rendering
      const renderedContent = markdownToHtml(line.content) || '&nbsp;';

      if (line.type === 'unchanged') {
        return `<div key="${lineKey}" class="pl-2 border-l-2 border-transparent">${renderedContent}</div>`;
      }

      if (line.type === 'add') {
        return `<div key="${lineKey}" class="pl-2 border-l-2 border-green-500 ${DIFF_STYLES.add}">${renderedContent}</div>`;
      }

      if (line.type === 'remove') {
        return `<div key="${lineKey}" class="pl-2 border-l-2 border-red-500 ${DIFF_STYLES.remove}">${renderedContent}</div>`;
      }

      return `<div key="${lineKey}">${renderedContent}</div>`;
    });

    const html = htmlParts.join('');

    // Sanitize HTML (SSR safety) - allow markdown-rendered elements
    const sanitizedHtml = typeof window === 'undefined'
      ? ''
      : DOMPurify.sanitize(html, {
          ALLOWED_TAGS: ['div', 'span', 'p', 'h1', 'h2', 'h3', 'strong', 'em', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'br'],
          ALLOWED_ATTR: ['class', 'key', 'href', 'target', 'rel'],
        });

    return (
      <div
        key={key}
        className="prose prose-sm max-w-none text-sm leading-relaxed dark:prose-invert"
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />
    );
  };

  return (
    <div className={cn("rounded-lg border bg-card overflow-hidden my-2 shadow-sm", className)}>
      {/* Header - clickable to navigate */}
      <button
        type="button"
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
          {/* Change stats (now in lines) */}
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

      {/* Content with contextual diff */}
      <div
        className="bg-white dark:bg-gray-900 overflow-auto"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        <div className="text-gray-900 dark:text-gray-100">
          {regions.map((region, idx) => {
            if (region.type === 'collapsed' && region.skippedCount) {
              return renderCollapsed(region.skippedCount, `collapsed-${idx}`);
            }
            if (region.type === 'hunk' && region.lines) {
              return (
                <div key={`hunk-${idx}`} className="px-3 py-2">
                  {renderHunk(region.lines, `hunk-${idx}`)}
                </div>
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
});
