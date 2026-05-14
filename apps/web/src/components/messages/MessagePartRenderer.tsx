'use client';

import React, { MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { usePageNavigation } from '@/hooks/usePageNavigation';
import { openExternalUrl, isInternalUrl } from '@/lib/navigation/app-navigation';

// Define the structure for message parts
export interface MessagePart {
  type: 'text' | 'rich-text' | 'tool-invocation';
  text?: string;
  content?: string | Record<string, unknown>;
  toolInvocation?: {
    toolName: string;
    args: Record<string, unknown>;
  };
}

interface MessagePartRendererProps {
  part: MessagePart;
  index: number;
  context?: 'message';
}

function parseTextIntoNodes(
  text: string,
  baseKey: string,
  onMentionClick: (e: MouseEvent<HTMLAnchorElement>, pageId: string) => void,
  onUrlClick: (e: MouseEvent<HTMLAnchorElement>, url: string) => void,
): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Local regex instance — avoids shared lastIndex state across concurrent renders
  // URL part allows ) in paths; unbalanced trailing ) handled in post-processing below
  const contentRegex = /@\[([^\]]+)\]\(([^:]+):([^)]+)\)|(https?:\/\/[^\s<>"'\]]+)/g;

  while ((match = contentRegex.exec(text)) !== null) {
    const preceding = text.slice(lastIndex, match.index);
    if (preceding) {
      elements.push(<span key={`${baseKey}-t-${lastIndex}`}>{preceding}</span>);
    }

    if (match[1] !== undefined) {
      // @mention: groups 1=label, 2=id, 3=type
      const [, label, id, type] = match;
      if (type === 'page') {
        elements.push(
          <a
            key={`${baseKey}-m-${match.index}`}
            href={`/p/${id}`}
            onClick={(e) => onMentionClick(e, id)}
            className="bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary px-1 rounded hover:bg-primary/20 dark:hover:bg-primary/30 transition-colors no-underline"
          >
            @{label}
          </a>
        );
      } else {
        elements.push(
          <span
            key={`${baseKey}-m-${match.index}`}
            className="bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary px-1 rounded"
          >
            @{label}
          </span>
        );
      }
      lastIndex = match.index + match[0].length;
    } else {
      // Bare URL: group 4
      const rawUrl = match[4];
      let url = rawUrl.replace(/[.,;:!?'">\]]+$/, '');
      let trailing = rawUrl.slice(url.length);

      // Strip unbalanced trailing ) — keeps balanced parens in paths (e.g. Wikipedia URLs)
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

      elements.push(
        <a
          key={`${baseKey}-u-${match.index}`}
          href={url}
          onClick={(e) => onUrlClick(e, url)}
          className="text-primary underline break-all [overflow-wrap:anywhere]"
        >
          {url}
        </a>
      );
      if (trailing) {
        elements.push(<span key={`${baseKey}-u-trail-${match.index}`}>{trailing}</span>);
      }
      lastIndex = match.index + match[0].length;
    }
  }

  const remaining = text.slice(lastIndex);
  if (remaining) {
    elements.push(<span key={`${baseKey}-t-${lastIndex}`}>{remaining}</span>);
  }

  return elements;
}

const MessagePartRenderer: React.FC<MessagePartRendererProps> = ({ part, index }) => {
  const router = useRouter();
  const { navigateToPage } = usePageNavigation();

  const handleMentionClick = (e: MouseEvent<HTMLAnchorElement>, pageId: string) => {
    e.preventDefault();
    navigateToPage(pageId);
  };

  const handleUrlClick = async (e: MouseEvent<HTMLAnchorElement>, url: string) => {
    e.preventDefault();
    if (isInternalUrl(url)) {
      router.push(url);
    } else {
      await openExternalUrl(url);
    }
  };

  switch (part.type) {
    case 'text': {
      const text = part.text || '';
      const nodes = parseTextIntoNodes(text, `${index}`, handleMentionClick, handleUrlClick);

      if (nodes.length === 0) {
        return <span key={index} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{text}</span>;
      }

      return <span key={index} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{nodes}</span>;
    }

    case 'rich-text': {
      const textContent = typeof part.content === 'string'
        ? part.content
        : JSON.stringify(part.content, null, 2);

      const nodes = parseTextIntoNodes(textContent, `${index}`, handleMentionClick, handleUrlClick);

      return <div key={index} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{nodes}</div>;
    }

    case 'tool-invocation':
      return (
        <div
          key={index}
          className="mt-2 p-2 border rounded-lg bg-muted"
        >
          <div className="font-semibold">
            {part.toolInvocation?.toolName}
          </div>
          <pre className="text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {JSON.stringify(part.toolInvocation?.args, null, 2)}
          </pre>
        </div>
      );

    default:
      console.warn('Unknown message part type:', part);
      return null;
  }
};

// Utility function to convert message content to parts format
export const convertToMessageParts = (content: string | Record<string, unknown>): MessagePart[] => {
  if (typeof content === 'string') {
    if (content.startsWith('{"type":"doc"')) {
      try {
        const parsedContent = JSON.parse(content);
        return [{
          type: 'rich-text',
          content: parsedContent
        }];
      } catch {
        return [{
          type: 'text',
          text: content
        }];
      }
    } else {
      return [{
        type: 'text',
        text: content
      }];
    }
  } else {
    return [{
      type: 'rich-text',
      content: content
    }];
  }
};

// Utility function to render all parts of a message
export const renderMessageParts = (parts: MessagePart[], context?: 'message'): React.ReactNode => {
  return parts.map((part, index) => (
    <MessagePartRenderer key={index} part={part} index={index} context={context} />
  ));
};

export default MessagePartRenderer;
