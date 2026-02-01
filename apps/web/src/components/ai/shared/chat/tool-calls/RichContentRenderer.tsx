'use client';

import React, { memo, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import DOMPurify from 'dompurify';
import { FileText, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

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

/**
 * Strips line numbers from content formatted as "123→content"
 * Used when displaying content that was returned with line numbers for AI context
 */
function stripLineNumbers(content: string): string {
  return content
    .split('\n')
    .map(line => {
      // Match pattern: number followed by → then content
      const match = line.match(/^\d+→(.*)$/);
      return match ? match[1] : line;
    })
    .join('\n');
}

/**
 * Simple markdown to HTML conversion for basic formatting
 * Handles: bold, italic, code, links, headers, lists
 */
function markdownToHtml(markdown: string): string {
  let html = markdown
    // Escape HTML entities first
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold and italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/___(.+?)___/g, '<strong><em>$1</em></strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    // Code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Unordered lists
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    // Ordered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Line breaks
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>');

  // Wrap in paragraph if not already structured
  if (!html.startsWith('<h') && !html.startsWith('<li')) {
    html = '<p>' + html + '</p>';
  }

  // Wrap list items in ul
  html = html.replace(/(<li>.*?<\/li>)+/gs, '<ul>$&</ul>');

  return html;
}

/**
 * Sanitizes HTML content for safe rendering
 */
function sanitizeHtml(html: string): string {
  if (typeof window === 'undefined') {
    return html;
  }

  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'style'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onmouseout', 'onfocus', 'onblur'],
    KEEP_CONTENT: true,
  });
}

/**
 * RichContentRenderer - Renders page content as beautiful HTML
 *
 * Features:
 * - Renders HTML/markdown content like a real page preview
 * - White background with proper typography
 * - Clickable header to navigate to the page
 * - Sanitized for security
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
  const processedHtml = useMemo(() => {
    // Strip line numbers if present
    const rawContent = stripLineNumbers(content);

    // Convert markdown to HTML if needed
    const html = isMarkdown ? markdownToHtml(rawContent) : rawContent;

    // Sanitize for security
    return sanitizeHtml(html);
  }, [content, isMarkdown]);

  // Check if content looks like HTML
  const hasHtmlContent = useMemo(() => {
    return /<[a-z][\s\S]*>/i.test(processedHtml);
  }, [processedHtml]);

  const handleNavigate = () => {
    if (pageId) {
      router.push(`/p/${pageId}`);
    }
  };

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

      {/* Content - rendered HTML */}
      <div
        className="bg-white dark:bg-gray-50 overflow-auto"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        <div
          className={cn(
            "p-4 text-gray-900 prose prose-sm max-w-none",
            // Typography styles for rendered content
            "[&_h1]:text-xl [&_h1]:font-bold [&_h1]:mb-3 [&_h1]:mt-0",
            "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4",
            "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mb-2 [&_h3]:mt-3",
            "[&_p]:mb-2 [&_p]:leading-relaxed",
            "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-2",
            "[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-2",
            "[&_li]:mb-1",
            "[&_code]:bg-gray-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_code]:font-mono",
            "[&_pre]:bg-gray-100 [&_pre]:p-3 [&_pre]:rounded [&_pre]:overflow-x-auto",
            "[&_a]:text-primary [&_a]:underline [&_a]:hover:text-primary/80",
            "[&_blockquote]:border-l-4 [&_blockquote]:border-gray-300 [&_blockquote]:pl-4 [&_blockquote]:italic",
            "[&_table]:w-full [&_table]:border-collapse",
            "[&_th]:border [&_th]:border-gray-300 [&_th]:p-2 [&_th]:bg-gray-100 [&_th]:font-semibold",
            "[&_td]:border [&_td]:border-gray-300 [&_td]:p-2"
          )}
          dangerouslySetInnerHTML={hasHtmlContent ? { __html: processedHtml } : undefined}
        >
          {!hasHtmlContent && (
            <pre className="whitespace-pre-wrap font-sans text-sm">{processedHtml}</pre>
          )}
        </div>
      </div>
    </div>
  );
});
