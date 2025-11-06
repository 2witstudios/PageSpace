import { marked } from 'marked';
import { memo, useMemo, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown);
  return tokens.map(token => token.raw);
}

/**
 * Process content to convert @mentions into visual badges
 * Converts @[Label](id:type) format to styled badges
 */
/**
 * Custom components for ReactMarkdown to ensure proper overflow handling
 */
const customComponents: Components = {
  // Ensure code blocks are properly constrained
  code: ({ node, className, children, ...props }: any) => {
    const isInline = !className?.includes('language-');
    if (isInline) {
      return (
        <code className={`${className || ''} max-w-full`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={`${className || ''} max-w-full block`} {...props}>
        {children}
      </code>
    );
  },
  // Ensure pre blocks are properly constrained
  pre: ({ children, ...props }) => (
    <pre className="max-w-full overflow-x-auto" {...props}>
      {children}
    </pre>
  ),
  // Ensure links don't overflow
  a: ({ children, ...props }) => (
    <a className="max-w-full break-words inline-block" {...props}>
      {children}
    </a>
  ),
  // Ensure paragraphs don't overflow
  p: ({ children, ...props }) => (
    <p className="max-w-full break-words" {...props}>
      {children}
    </p>
  ),
  // Ensure tables are scrollable
  table: ({ children, ...props }) => (
    <div className="max-w-full overflow-x-auto">
      <table {...props}>{children}</table>
    </div>
  ),
};

function processMentions(content: string): ReactNode[] {
  const mentionRegex = /@\[([^\]]+)\]\(([^:]+):([^)]+)\)/g;
  const elements: ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let keyIndex = 0;

  while ((match = mentionRegex.exec(content)) !== null) {
    const [fullMatch, label] = match;
    const precedingText = content.slice(lastIndex, match.index);

    if (precedingText) {
      elements.push(
        <ReactMarkdown key={`text-${keyIndex++}`} components={customComponents}>
          {precedingText}
        </ReactMarkdown>
      );
    }

    elements.push(
      <span
        key={`mention-${keyIndex++}`}
        className="inline-flex items-center px-2 py-0.5 rounded-md bg-primary/20 text-primary dark:bg-primary/30 dark:text-primary text-sm font-medium mx-1"
      >
        @{label}
      </span>
    );

    lastIndex = match.index + fullMatch.length;
  }

  const remainingText = content.slice(lastIndex);
  if (remainingText) {
    elements.push(
      <ReactMarkdown key={`text-${keyIndex++}`} components={customComponents}>
        {remainingText}
      </ReactMarkdown>
    );
  }

  // If no mentions found, return the content as-is with ReactMarkdown
  if (elements.length === 0) {
    return [<ReactMarkdown key="content" components={customComponents}>{content}</ReactMarkdown>];
  }

  return elements;
}

const MemoizedMarkdownBlock = memo(
  ({ content }: { content: string }) => {
    const processedContent = useMemo(() => processMentions(content), [content]);
    return <>{processedContent}</>;
  },
  (prevProps, nextProps) => {
    if (prevProps.content !== nextProps.content) return false;
    return true;
  },
);

MemoizedMarkdownBlock.displayName = 'MemoizedMarkdownBlock';

export const MemoizedMarkdown = memo(
  ({ content, id }: { content: string; id: string }) => {
    const blocks = useMemo(() => parseMarkdownIntoBlocks(content), [content]);

    return (
      <>
        {blocks.map((block, index) => (
          <MemoizedMarkdownBlock content={block} key={`${id}-block_${index}`} />
        ))}
      </>
    );
  },
);

MemoizedMarkdown.displayName = 'MemoizedMarkdown';