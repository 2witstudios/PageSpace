"use client";

import React from 'react';
import { DocumentPreviewContainer } from './DocumentPreviewContainer';
import type { PageType } from '@pagespace/lib/client-safe';

interface ReadPagePreviewProps {
  title: string;
  pageId: string;
  driveId: string;
  content: string;
  pageType?: PageType;
  isTaskLinked?: boolean;
  stats?: {
    lineCount?: number;
    wordCount?: number;
    characterCount?: number;
  };
  className?: string;
}

/**
 * Strips line number prefixes from content returned by read_page tool.
 * Format: "1→content" or "42→content"
 */
function stripLineNumbers(content: string): string {
  return content
    .split('\n')
    .map(line => {
      // Match line number prefix: digits followed by →
      const match = line.match(/^\d+→(.*)$/);
      return match ? match[1] : line;
    })
    .join('\n');
}

export const ReadPagePreview: React.FC<ReadPagePreviewProps> = ({
  title,
  pageId,
  driveId,
  content,
  pageType = 'DOCUMENT',
  isTaskLinked,
  stats,
  className
}) => {
  // Strip line numbers if present (from read_page tool format)
  const cleanContent = stripLineNumbers(content);

  return (
    <div className={className}>
      {/* Stats summary */}
      {stats && (
        <div className="text-xs text-muted-foreground mb-2 flex items-center gap-2">
          {stats.lineCount !== undefined && (
            <span>{stats.lineCount} lines</span>
          )}
          {stats.wordCount !== undefined && (
            <>
              <span className="text-muted-foreground/50">•</span>
              <span>{stats.wordCount.toLocaleString()} words</span>
            </>
          )}
          {stats.characterCount !== undefined && (
            <>
              <span className="text-muted-foreground/50">•</span>
              <span>{stats.characterCount.toLocaleString()} chars</span>
            </>
          )}
        </div>
      )}

      <DocumentPreviewContainer
        content={cleanContent}
        title={title}
        pageId={pageId}
        driveId={driveId}
        pageType={pageType}
        isTaskLinked={isTaskLinked}
        showNavigation={true}
      />
    </div>
  );
};
