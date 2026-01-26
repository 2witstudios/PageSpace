/**
 * StreamingMarkdown - Optimized markdown rendering for AI streaming
 *
 * Uses Streamdown (Vercel's streaming-optimized markdown renderer) with:
 * - Progressive formatting during streaming
 * - Handles incomplete markdown syntax gracefully
 * - Built-in memoization for performance
 * - Custom mention rendering support
 * - Mobile-aware link handling (stays in WebView on Capacitor)
 */

'use client';

import { memo, useMemo, AnchorHTMLAttributes, HTMLAttributes, TableHTMLAttributes, ReactNode, MouseEvent, useCallback } from 'react';
import { Streamdown } from 'streamdown';
import { useRouter } from 'next/navigation';
import { isInternalUrl, openExternalUrl } from '@/lib/navigation/app-navigation';

/** Router interface for navigation - compatible with Next.js useRouter */
interface RouterLike {
  push: (url: string) => void;
}

/**
 * Regex pattern for mention preprocessing
 * Matches @[Label](id:type) format
 * Moved to module scope to avoid recreation on every function call
 */
const MENTION_REGEX = /@\[([^\]]+)\]\(([^:]+):([^)]+)\)/g;

/**
 * Pre-process content to convert @mentions into markdown links with special protocol
 * Converts @[Label](id:type) format to [mention:@Label](mention://id/type)
 * which Streamdown will render as a link that we handle specially
 */
function preprocessMentions(content: string): string {
  // Reset lastIndex since we're reusing the regex (it's stateful with /g flag)
  MENTION_REGEX.lastIndex = 0;
  return content.replace(MENTION_REGEX, (_, label, id, type) => {
    // Convert to a special link format that we'll intercept in the component
    return `[mention:${label}](mention://${id}/${type})`;
  });
}

// Custom code component with proper overflow handling
function CustomCode({ className, children, ...props }: HTMLAttributes<HTMLElement> & { children?: ReactNode }) {
  const isInline = !className?.includes('language-');
  if (isInline) {
    return (
      <code className={`${className || ''} min-w-0 max-w-full break-all [overflow-wrap:anywhere]`} {...props}>
        {children}
      </code>
    );
  }
  return (
    <code className={`${className || ''} min-w-0 max-w-full block break-all [overflow-wrap:anywhere]`} {...props}>
      {children}
    </code>
  );
}

// Custom pre component with overflow handling
function CustomPre({ children, ...props }: HTMLAttributes<HTMLPreElement> & { children?: ReactNode }) {
  return (
    <pre className="min-w-0 max-w-full overflow-x-auto" {...props}>
      {children}
    </pre>
  );
}

// Custom paragraph component with word breaking
function CustomParagraph({ children, ...props }: HTMLAttributes<HTMLParagraphElement> & { children?: ReactNode }) {
  return (
    <p className="min-w-0 max-w-full [overflow-wrap:anywhere]" {...props}>
      {children}
    </p>
  );
}

// Custom table component with horizontal scroll
function CustomTable({ children, ...props }: TableHTMLAttributes<HTMLTableElement> & { children?: ReactNode }) {
  return (
    <div className="min-w-0 max-w-full overflow-x-auto">
      <table {...props}>{children}</table>
    </div>
  );
}

// Custom list item component with word breaking
function CustomListItem({ children, ...props }: HTMLAttributes<HTMLLIElement> & { children?: ReactNode }) {
  return (
    <li className="min-w-0 max-w-full break-all [overflow-wrap:anywhere]" {...props}>
      {children}
    </li>
  );
}

// Custom span component for inline text - uses overflow-wrap only to preserve word boundaries
function CustomSpan({ children, ...props }: HTMLAttributes<HTMLSpanElement> & { children?: ReactNode }) {
  return (
    <span className="min-w-0 max-w-full [overflow-wrap:anywhere]" {...props}>
      {children}
    </span>
  );
}

/**
 * Create custom anchor component with router for mobile-aware navigation
 */
function createCustomAnchor(router: RouterLike) {
  return function CustomAnchor({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) {
    const handleClick = async (e: MouseEvent<HTMLAnchorElement>) => {
      if (!href) return;

      e.preventDefault();

      if (isInternalUrl(href)) {
        router.push(href);
      } else {
        await openExternalUrl(href);
      }
    };

    // Check if this is a mention link
    if (typeof href === 'string' && href.startsWith('mention://')) {
      // Extract the label from children (format: "mention:Label")
      const label = typeof children === 'string'
        ? children.replace(/^mention:/, '')
        : Array.isArray(children) && typeof children[0] === 'string'
          ? children[0].replace(/^mention:/, '')
          : children;

      // Parse the mention URL: mention://id/type
      const mentionPath = href.replace('mention://', '');
      const [id, type] = mentionPath.split('/');

      // Only page mentions should be clickable links
      // User and other mention types render as non-clickable badges
      if (type === 'page') {
        const pageHref = `/p/${id}`;
        return (
          <a
            href={pageHref}
            onClick={(e) => {
              e.preventDefault();
              router.push(pageHref);
            }}
            className="inline-flex items-center px-2 py-0.5 rounded-md bg-primary/20 text-primary dark:bg-primary/30 dark:text-primary text-sm font-medium mx-1 hover:bg-primary/30 dark:hover:bg-primary/40 transition-colors cursor-pointer no-underline"
            {...props}
          >
            @{label}
          </a>
        );
      }

      // Non-page mentions (user, agent, etc.) render as styled badges without links
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-primary/20 text-primary dark:bg-primary/30 dark:text-primary text-sm font-medium mx-1">
          @{label}
        </span>
      );
    }

    // Regular link with mobile-aware click handling
    return (
      <a
        href={href}
        onClick={handleClick}
        className="min-w-0 max-w-full break-all [overflow-wrap:anywhere] inline-block"
        {...props}
      >
        {children}
      </a>
    );
  };
}

/**
 * Create streamdown components with router for mobile-aware navigation
 */
function createStreamdownComponents(router: RouterLike) {
  return {
    a: createCustomAnchor(router),
    code: CustomCode,
    pre: CustomPre,
    p: CustomParagraph,
    table: CustomTable,
    li: CustomListItem,
    span: CustomSpan,
  };
}

interface StreamingMarkdownProps {
  content: string;
  /** @deprecated id is no longer used - kept for backward compatibility */
  id?: string;
  /** Whether to use streaming mode (progressive formatting) or static mode */
  isStreaming?: boolean;
  /** Additional CSS class */
  className?: string;
}

/**
 * Streaming-optimized markdown renderer
 *
 * Features:
 * - Handles incomplete markdown during streaming
 * - Progressive formatting (applies styles to partial content)
 * - Built-in memoization
 * - Custom mention rendering
 * - Mobile-aware link handling (internal links use router.push on Capacitor)
 */
export const StreamingMarkdown = memo(
  ({ content, isStreaming = false, className }: StreamingMarkdownProps) => {
    const router = useRouter();

    // Pre-process mentions before rendering
    const processedContent = useMemo(() => preprocessMentions(content), [content]);

    // Create components with router for mobile-aware navigation
    // Memoize to avoid recreating on every render
    const streamdownComponents = useMemo(() => createStreamdownComponents(router), [router]);

    return (
      <Streamdown
        mode={isStreaming ? 'streaming' : 'static'}
        components={streamdownComponents}
        className={className}
        // Disable controls for chat messages (copy/download buttons on code blocks)
        controls={false}
      >
        {processedContent}
      </Streamdown>
    );
  },
  (prevProps, nextProps) => {
    // Custom equality check for better memoization
    return prevProps.content === nextProps.content &&
           prevProps.isStreaming === nextProps.isStreaming &&
           prevProps.className === nextProps.className;
  }
);

StreamingMarkdown.displayName = 'StreamingMarkdown';
