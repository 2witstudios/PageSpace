import { marked } from 'marked';
import { memo, useMemo, ReactNode } from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import rehypeRaw from 'rehype-raw';

// Custom components to ensure proper text sizing and overflow handling
const markdownComponents: Partial<Components> = {
  p: ({ children, ...props }) => (
    <p className="text-xs mb-1 break-words overflow-wrap-anywhere" {...props}>
      {children}
    </p>
  ),
  h1: ({ children, ...props }) => (
    <h1 className="text-sm font-bold mb-1 break-words" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="text-sm font-semibold mb-1 break-words" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="text-xs font-semibold mb-1 break-words" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="text-xs font-medium mb-1 break-words" {...props}>
      {children}
    </h4>
  ),
  h5: ({ children, ...props }) => (
    <h5 className="text-xs font-medium mb-1 break-words" {...props}>
      {children}
    </h5>
  ),
  h6: ({ children, ...props }) => (
    <h6 className="text-xs font-medium mb-1 break-words" {...props}>
      {children}
    </h6>
  ),
  ul: ({ children, ...props }) => (
    <ul className="text-xs list-disc pl-4 mb-1 break-words" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="text-xs list-decimal pl-4 mb-1 break-words" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="text-xs mb-0.5 break-words overflow-wrap-anywhere" {...props}>
      {children}
    </li>
  ),
  code: ({ children, ...props }) => (
    <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded break-words" {...props}>
      {children}
    </code>
  ),
  pre: ({ children, ...props }) => (
    <pre className="text-xs bg-gray-100 dark:bg-gray-800 p-2 rounded overflow-x-auto max-w-full" {...props}>
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote className="text-xs border-l-2 pl-2 italic mb-1" {...props}>
      {children}
    </blockquote>
  ),
  a: ({ children, ...props }) => (
    <a className="text-xs text-blue-600 dark:text-blue-400 hover:underline break-words" {...props}>
      {children}
    </a>
  ),
  table: ({ children, ...props }) => (
    <div className="overflow-x-auto max-w-full">
      <table className="text-xs min-w-full" {...props}>
        {children}
      </table>
    </div>
  ),
  td: ({ children, ...props }) => (
    <td className="text-xs px-2 py-1 border break-words" {...props}>
      {children}
    </td>
  ),
  th: ({ children, ...props }) => (
    <th className="text-xs px-2 py-1 border font-medium break-words" {...props}>
      {children}
    </th>
  ),
};

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown);
  return tokens.map(token => token.raw);
}

/**
 * Process content to convert @mentions into visual badges
 * Converts @[Label](id:type) format to styled badges
 */
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
        <ReactMarkdown 
          key={`text-${keyIndex++}`}
          components={markdownComponents}
          rehypePlugins={[rehypeRaw]}
        >
          {precedingText}
        </ReactMarkdown>
      );
    }
    
    elements.push(
      <span 
        key={`mention-${keyIndex++}`} 
        className="inline-flex items-center px-2 py-0.5 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 text-sm font-medium mx-1"
      >
        @{label}
      </span>
    );
    
    lastIndex = match.index + fullMatch.length;
  }

  const remainingText = content.slice(lastIndex);
  if (remainingText) {
    elements.push(
      <ReactMarkdown 
        key={`text-${keyIndex++}`}
        components={markdownComponents}
        rehypePlugins={[rehypeRaw]}
      >
        {remainingText}
      </ReactMarkdown>
    );
  }

  // If no mentions found, return the content as-is with ReactMarkdown
  if (elements.length === 0) {
    return [
      <ReactMarkdown 
        key="content"
        components={markdownComponents}
        rehypePlugins={[rehypeRaw]}
      >
        {content}
      </ReactMarkdown>
    ];
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