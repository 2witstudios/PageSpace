'use client';

import React, { memo, useMemo } from 'react';
import { Globe, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { markdownToHtml, sanitizeHtmlAllowlist } from './content-utils';

interface WebFetchRendererProps {
  url: string;
  content?: string;
  contentLength?: number;
  truncated?: boolean;
  maxHeight?: number;
  className?: string;
}

const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const PROSE_STYLES = cn(
  'p-4 text-gray-900 dark:text-gray-100 prose prose-sm max-w-none',
  '[&_h1]:text-lg [&_h1]:font-bold [&_h1]:mb-2 [&_h1]:mt-0',
  '[&_h2]:text-base [&_h2]:font-semibold [&_h2]:mb-2 [&_h2]:mt-3',
  '[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2',
  '[&_p]:mb-2 [&_p]:leading-relaxed',
  '[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-2',
  '[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-2',
  '[&_li]:mb-1',
  '[&_code]:bg-gray-100 [&_code]:dark:bg-gray-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm',
  '[&_a]:text-primary [&_a]:underline',
  '[&_blockquote]:border-l-4 [&_blockquote]:border-gray-300 [&_blockquote]:dark:border-gray-600 [&_blockquote]:pl-4 [&_blockquote]:italic'
);

/**
 * WebFetchRenderer - Fetched page content from web_fetch, rendered as markdown.
 */
export const WebFetchRenderer: React.FC<WebFetchRendererProps> = memo(function WebFetchRenderer({
  url,
  content,
  contentLength,
  truncated,
  maxHeight = 320,
  className,
}) {
  const html = useMemo(() => {
    if (!content) return '';
    return sanitizeHtmlAllowlist(markdownToHtml(content));
  }, [content]);

  const host = hostnameOf(url);

  return (
    <div className={cn('rounded-lg border bg-card overflow-hidden my-2 shadow-sm', className)}>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate" title={url}>
            {host}
          </span>
        </div>
        <span className="flex items-center gap-2 shrink-0">
          {truncated && (
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">truncated</span>
          )}
          {typeof contentLength === 'number' && (
            <span className="text-xs text-muted-foreground">{contentLength.toLocaleString()} chars</span>
          )}
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      </a>

      {content ? (
        <div
          className="bg-white dark:bg-gray-900 overflow-auto"
          style={{ maxHeight: `${maxHeight}px` }}
        >
          <div className={PROSE_STYLES} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      ) : (
        <div className="text-sm text-muted-foreground text-center py-4">No content fetched</div>
      )}
    </div>
  );
});
