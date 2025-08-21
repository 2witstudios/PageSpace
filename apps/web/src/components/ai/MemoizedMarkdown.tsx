import { marked } from 'marked';
import { memo, useMemo, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';

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
        <ReactMarkdown key={`text-${keyIndex++}`}>
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
      <ReactMarkdown key={`text-${keyIndex++}`}>
        {remainingText}
      </ReactMarkdown>
    );
  }

  // If no mentions found, return the content as-is with ReactMarkdown
  if (elements.length === 0) {
    return [<ReactMarkdown key="content">{content}</ReactMarkdown>];
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