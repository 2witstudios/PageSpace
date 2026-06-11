'use client';

import { memo, useMemo, useState, useRef, useEffect, useCallback, AnchorHTMLAttributes, HTMLAttributes, TableHTMLAttributes, ReactNode, MouseEvent } from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import { useRouter } from 'next/navigation';
import { isInternalUrl, openExternalUrl } from '@/lib/navigation/app-navigation';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { preprocessCommandTokens } from '@/lib/commands/command-chip-model';
import { CommandChip } from './CommandChip';

interface RouterLike {
  push: (url: string) => void;
}

function preprocessMentions(content: string): string {
  return content.replace(/@\[([^\]]+)\]\(([^:]+):([^)]+)\)/g, (_, label, id, type) => {
    return `[mention:${label}](/mention/${id}/${type})`;
  });
}

function autoLinkUrls(content: string): string {
  return content.replace(/(?<!\[)(?<!\()(https?:\/\/[^\s<>"'\]]+)/g, (rawUrl) => {
    let url = rawUrl.replace(/[.,;:!?'">\]]+$/, '');
    let trailing = rawUrl.slice(url.length);

    while (url.endsWith(')')) {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) {
        trailing = ')' + trailing;
        url = url.slice(0, -1);
      } else {
        break;
      }
    }

    return `[${url}](${url})${trailing}`;
  });
}

/** Converts single \n to CommonMark hard line breaks (two trailing spaces + \n).
 * Leaves \n\n paragraph breaks untouched. Use for user-typed content only —
 * not AI-generated markdown where \n has structural meaning (lists, code blocks). */
export function addHardLineBreaks(content: string): string {
  return content.replace(/(?<=[^\n])\n(?=[^\n])/g, '  \n');
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  [key: string]: unknown;
}

function isMarkdownParent(node: MarkdownNode): node is MarkdownNode & { children: MarkdownNode[] } {
  return Array.isArray(node.children);
}

function renderRawHtmlNodesAsText(tree: MarkdownNode): void {
  if (!isMarkdownParent(tree)) {
    return;
  }

  tree.children = tree.children.map((child) => {
    if (child.type === 'html') {
      return {
        ...child,
        type: 'text',
      };
    }

    renderRawHtmlNodesAsText(child);
    return child;
  });
}

function renderHtmlAsTextRemarkPlugin() {
  return (tree: MarkdownNode) => {
    renderRawHtmlNodesAsText(tree);
  };
}

function extractTextFromChildren(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (!children) return '';

  if (Array.isArray(children)) {
    return children.map(extractTextFromChildren).join('');
  }

  if (typeof children === 'object' && 'props' in children) {
    const props = (children as { props: { children?: ReactNode } }).props;
    if (props.children !== undefined) {
      return extractTextFromChildren(props.children);
    }
  }

  return '';
}

function CodeCopyButton({ code, className }: { code: string; className?: string }) {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (typeof window === 'undefined' || !navigator?.clipboard?.writeText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setIsCopied(false);
        timeoutRef.current = null;
      }, 2000);
    } catch (error) {
      console.error('Failed to copy code:', error);
    }
  }, [code]);

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={handleCopy}
          className={cn(
            'absolute top-2 right-2 p-1.5 rounded-md',
            'bg-background/80 hover:bg-muted border border-border/50',
            'opacity-100 transition-opacity',
            'focus:outline-none focus:ring-2 focus:ring-ring',
            className
          )}
          aria-label={isCopied ? 'Copied' : 'Copy code'}
          type="button"
        >
          <Icon size={14} className={isCopied ? 'text-green-500' : 'text-muted-foreground'} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{isCopied ? 'Copied!' : 'Copy code'}</TooltipContent>
    </Tooltip>
  );
}

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

function CustomPre({ children, ...props }: HTMLAttributes<HTMLPreElement> & { children?: ReactNode }) {
  const code = extractTextFromChildren(children);

  return (
    <div className="group relative min-w-0 max-w-full">
      <pre className="min-w-0 max-w-full overflow-x-auto" {...props}>
        {children}
      </pre>
      {code && <CodeCopyButton code={code} />}
    </div>
  );
}

function CustomParagraph({ children, ...props }: HTMLAttributes<HTMLParagraphElement> & { children?: ReactNode }) {
  return (
    <p className="min-w-0 max-w-full [overflow-wrap:break-word] [hyphens:auto] [text-wrap:pretty]" {...props}>
      {children}
    </p>
  );
}

function CustomTable({ children, ...props }: TableHTMLAttributes<HTMLTableElement> & { children?: ReactNode }) {
  return (
    <div className="min-w-0 max-w-full overflow-x-auto">
      <table {...props}>{children}</table>
    </div>
  );
}

function CustomListItem({ children, className, ...props }: HTMLAttributes<HTMLLIElement> & { children?: ReactNode }) {
  return (
    <li className={cn("min-w-0 max-w-full [overflow-wrap:break-word] [hyphens:auto] [text-wrap:pretty]", className)} {...props}>
      {children}
    </li>
  );
}

// list-outside with padding keeps markers inside the padded area,
// safe from overflow:hidden on ancestor containers (Streamdown's list-inside can be clipped).
function CustomOrderedList({ children, className, ...props }: HTMLAttributes<HTMLOListElement> & { children?: ReactNode }) {
  return (
    <ol className={cn("list-decimal list-outside pl-6 my-2", className)} {...props}>
      {children}
    </ol>
  );
}

function CustomUnorderedList({ children, className, ...props }: HTMLAttributes<HTMLUListElement> & { children?: ReactNode }) {
  return (
    <ul className={cn("list-disc list-outside pl-6 my-2", className)} {...props}>
      {children}
    </ul>
  );
}

function CustomSpan({ children, ...props }: HTMLAttributes<HTMLSpanElement> & { children?: ReactNode }) {
  return (
    <span className="min-w-0 max-w-full [overflow-wrap:break-word] [hyphens:auto]" {...props}>
      {children}
    </span>
  );
}

function createCustomAnchor(router: RouterLike, commandChipInert?: boolean) {
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

    // Command chip (UX spec §5) — rewritten by preprocessCommandTokens.
    if (typeof href === 'string' && href.startsWith('/command/')) {
      const commandId = href.slice('/command/'.length);
      const rawLabel = typeof children === 'string'
        ? children
        : Array.isArray(children) && typeof children[0] === 'string'
          ? children[0]
          : '';
      const label = rawLabel.replace(/^command:/, '');

      if (commandId && label) {
        return <CommandChip commandId={commandId} label={label} inertNoAI={commandChipInert} />;
      }
    }

    if (typeof href === 'string' && href.startsWith('/mention/')) {
      const label = typeof children === 'string'
        ? children.replace(/^mention:/, '')
        : Array.isArray(children) && typeof children[0] === 'string'
          ? children[0].replace(/^mention:/, '')
          : children;

      const mentionPath = href.slice('/mention/'.length);
      const lastSlash = mentionPath.lastIndexOf('/');
      const id = mentionPath.slice(0, lastSlash);
      const type = mentionPath.slice(lastSlash + 1);

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

      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-primary/20 text-primary dark:bg-primary/30 dark:text-primary text-sm font-medium mx-1">
          @{label}
        </span>
      );
    }

    return (
      <a
        href={href}
        onClick={handleClick}
        className="min-w-0 max-w-full break-all [overflow-wrap:anywhere] inline-block text-primary underline underline-offset-2 hover:opacity-80 transition-opacity cursor-pointer"
        {...props}
      >
        {children}
      </a>
    );
  };
}

function createStreamdownComponents(router: RouterLike, commandChipInert?: boolean) {
  return {
    a: createCustomAnchor(router, commandChipInert),
    code: CustomCode,
    pre: CustomPre,
    p: CustomParagraph,
    table: CustomTable,
    ol: CustomOrderedList,
    ul: CustomUnorderedList,
    li: CustomListItem,
    span: CustomSpan,
  };
}

interface RichTextProps {
  content: string;
  isStreaming?: boolean;
  renderHtmlAsText?: boolean;
  className?: string;
  /**
   * The message sits in a conversation with no AI participant, so its
   * command chip ran nothing (UX spec §6) — adds the inert tooltip suffix.
   */
  commandChipInert?: boolean;
}

export const RichText = memo(
  ({ content, isStreaming = false, renderHtmlAsText = false, className, commandChipInert }: RichTextProps) => {
    const router = useRouter();

    const processedContent = useMemo(
      () => autoLinkUrls(preprocessCommandTokens(preprocessMentions(content))),
      [content]
    );

    const streamdownComponents = useMemo(
      () => createStreamdownComponents(router, commandChipInert),
      [router, commandChipInert]
    );
    const remarkPlugins = useMemo(() => {
      if (!renderHtmlAsText) {
        return undefined;
      }

      return [...Object.values(defaultRemarkPlugins), renderHtmlAsTextRemarkPlugin];
    }, [renderHtmlAsText]);

    return (
      <Streamdown
        mode={isStreaming ? 'streaming' : 'static'}
        components={streamdownComponents}
        remarkPlugins={remarkPlugins}
        className={className}
        controls={false}
      >
        {processedContent}
      </Streamdown>
    );
  },
  (prevProps, nextProps) => {
    return prevProps.content === nextProps.content &&
           prevProps.isStreaming === nextProps.isStreaming &&
           prevProps.renderHtmlAsText === nextProps.renderHtmlAsText &&
           prevProps.className === nextProps.className &&
           prevProps.commandChipInert === nextProps.commandChipInert;
  }
);

RichText.displayName = 'RichText';
