/**
 * Shared utilities for content rendering in tool call displays
 */

import DOMPurify from 'dompurify';

/**
 * Strips line numbers from content formatted as "123→content"
 * Used when displaying content that was returned with line numbers for AI context
 */
export function stripLineNumbers(content: string): string {
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
 *
 * Note: For complex markdown, consider using a full parser.
 * This handles common cases in page content.
 */
export function markdownToHtml(markdown: string): string {
  let html = markdown
    // Escape HTML entities first
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headers (process before paragraphs)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold and italic (process in order of specificity)
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/___(.+?)___/g, '<strong><em>$1</em></strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Unordered lists
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    // Ordered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Line breaks (preserve double newlines as paragraphs)
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>');

  // Wrap in paragraph if not already structured
  if (!html.startsWith('<h') && !html.startsWith('<li')) {
    html = '<p>' + html + '</p>';
  }

  // Wrap consecutive list items in ul
  html = html.replace(/(<li>.*?<\/li>)+/gs, '<ul>$&</ul>');

  return html;
}

/**
 * Sanitizes HTML content using allowlist approach for security
 * More secure than blocklist as it's resilient to new attack vectors
 *
 * SSR Safety: Returns empty string on server to prevent unsanitized HTML emission.
 * Content will be sanitized and rendered client-side after hydration.
 */
export function sanitizeHtmlAllowlist(html: string): string {
  // SSR safety: return empty string on server to prevent unsanitized HTML
  // The component will re-render client-side with proper sanitization
  if (typeof window === 'undefined') {
    return '';
  }

  return DOMPurify.sanitize(html, {
    // Allowlist approach - only permit known safe tags
    ALLOWED_TAGS: [
      // Text formatting
      'p', 'br', 'span', 'div',
      'strong', 'b', 'em', 'i', 'u', 's', 'strike',
      'code', 'pre', 'kbd', 'samp',
      // Headings
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      // Lists
      'ul', 'ol', 'li',
      // Links
      'a',
      // Tables
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
      // Quotes
      'blockquote', 'q', 'cite',
      // Other safe elements
      'hr', 'sup', 'sub', 'small', 'mark',
    ],
    // Only allow safe attributes
    ALLOWED_ATTR: [
      'href', 'title', 'target', 'rel',
      'class', 'id',
      'colspan', 'rowspan', 'scope',
    ],
    // Additional security
    ALLOW_DATA_ATTR: false,
    FORBID_CONTENTS: ['script', 'style'],
    // Force safe link targets
    ADD_ATTR: ['target'],
  });
}

/**
 * CSS classes for diff highlighting that work with Tailwind dark mode
 */
export const DIFF_STYLES = {
  add: 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200 px-0.5 rounded-sm',
  remove: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 px-0.5 rounded-sm line-through',
  unchanged: '',
} as const;
