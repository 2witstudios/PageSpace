'use client';

import React, { memo, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { stripLineNumbers, markdownToHtml, sanitizeHtmlAllowlist } from './content-utils';

interface RichContentRendererProps {
  /** Page title for display */
  title: string;
  /** HTML or markdown content to render */
  content: string;
  /** Page ID for navigation (optional) */
  pageId?: string;
  /** Page type for display context */
  pageType?: string;
  /** Whether content is markdown (will be rendered as HTML) */
  isMarkdown?: boolean;
  /** Maximum height before scrolling (default: 300px) */
  maxHeight?: number;
  /** Additional CSS class */
  className?: string;
}

/** Shared prose styles for rendered content */
const PROSE_STYLES = cn(
  "p-4 text-gray-900 dark:text-gray-100 prose prose-sm max-w-none",
  // Typography styles for rendered content
  "[&_h1]:text-xl [&_h1]:font-bold [&_h1]:mb-3 [&_h1]:mt-0",
  "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4",
  "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mb-2 [&_h3]:mt-3",
  "[&_p]:mb-2 [&_p]:leading-relaxed",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-2",
  "[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-2",
  "[&_li]:mb-1",
  "[&_code]:bg-gray-100 [&_code]:dark:bg-gray-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_code]:font-mono",
  "[&_pre]:bg-gray-100 [&_pre]:dark:bg-gray-800 [&_pre]:p-3 [&_pre]:rounded [&_pre]:overflow-x-auto",
  "[&_a]:text-primary [&_a]:underline [&_a]:hover:text-primary/80",
  "[&_blockquote]:border-l-4 [&_blockquote]:border-gray-300 [&_blockquote]:dark:border-gray-600 [&_blockquote]:pl-4 [&_blockquote]:italic",
  "[&_table]:w-full [&_table]:border-collapse",
  "[&_th]:border [&_th]:border-gray-300 [&_th]:dark:border-gray-600 [&_th]:p-2 [&_th]:bg-gray-100 [&_th]:dark:bg-gray-800 [&_th]:font-semibold",
  "[&_td]:border [&_td]:border-gray-300 [&_td]:dark:border-gray-600 [&_td]:p-2"
);

/**
 * RichContentRenderer - Renders page content as beautiful HTML
 *
 * Features:
 * - Renders HTML/markdown content like a real page preview
 * - White background with proper typography
 * - Clickable header to navigate to the page
 * - Sanitized using allowlist approach for security
 */
export const RichContentRenderer: React.FC<RichContentRendererProps> = memo(function RichContentRenderer({
  title,
  content,
  pageId,
  pageType,
  isMarkdown = false,
  maxHeight = 300,
  className
}) {
  const router = useRouter();

  // Process content: strip line numbers and convert markdown if needed
  const { processedHtml, hasHtmlContent } = useMemo(() => {
    // Strip line numbers if present
    const rawContent = stripLineNumbers(content);

    // Check if content already looks like HTML (has actual HTML tags)
    // This detects content from TipTap editor which outputs HTML
    const contentIsHtml = /<[a-z][\s\S]*>/i.test(rawContent);

    // Convert to HTML:
    // - If content is already HTML, preserve it (markdownToHtml would escape the tags)
    // - If content is not HTML (markdown or plain text), convert markdown to HTML
    // - isMarkdown prop can force markdown conversion for edge cases
    const html = (contentIsHtml && !isMarkdown) ? rawContent : markdownToHtml(rawContent);

    // After conversion, check if we have HTML to render
    const hasHtml = /<[a-z][\s\S]*>/i.test(html);

    // Sanitize HTML content using allowlist approach
    const sanitized = hasHtml ? sanitizeHtmlAllowlist(html) : html;

    return { processedHtml: sanitized, hasHtmlContent: hasHtml };
  }, [content, isMarkdown]);

  const handleNavigate = () => {
    if (pageId) {
      router.push(`/p/${pageId}`);
    }
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
          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate" title={title}>{title}</span>
          {pageType && (
            <span className="text-xs text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded capitalize">
              {pageType.toLowerCase()}
            </span>
          )}
        </div>
        {pageId && (
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
      </button>

      {/* Content - rendered HTML or plain text */}
      <div
        className="bg-white dark:bg-gray-900 overflow-auto"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        {hasHtmlContent ? (
          // HTML content - render with dangerouslySetInnerHTML (no children)
          <div
            className={PROSE_STYLES}
            dangerouslySetInnerHTML={{ __html: processedHtml }}
          />
        ) : (
          // Plain text content - render as preformatted text
          <div className={PROSE_STYLES}>
            <pre className="whitespace-pre-wrap font-sans text-sm m-0">{processedHtml}</pre>
          </div>
        )}
      </div>
    </div>
  );
});
