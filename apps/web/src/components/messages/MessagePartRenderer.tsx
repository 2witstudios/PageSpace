import React from 'react';

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

const MessagePartRenderer: React.FC<MessagePartRendererProps> = ({ part, index }) => {
  switch (part.type) {
    case 'text':
      // Check if text contains mentions in markdown-typed format
      const text = part.text || '';
      const textMentionRegex = /@\[([^\]]+)\]\(([^:]+):([^)]+)\)/g;
      const textElements = [];
      let textLastIndex = 0;
      let textMatch;

      while ((textMatch = textMentionRegex.exec(text)) !== null) {
        const [fullMatch, label] = textMatch;
        const precedingText = text.slice(textLastIndex, textMatch.index);
        if (precedingText) {
          textElements.push(<span key={`${index}-text-${textLastIndex}`}>{precedingText}</span>);
        }
        textElements.push(
          <span key={`${index}-mention-${textMatch.index}`} className="bg-blue-100 text-blue-800 px-1 rounded">
            @{label}
          </span>
        );
        textLastIndex = textMatch.index + fullMatch.length;
      }

      const remainingTextContent = text.slice(textLastIndex);
      if (remainingTextContent) {
        textElements.push(<span key={`${index}-text-${textLastIndex}`}>{remainingTextContent}</span>);
      }

      // If no mentions found, just return the plain text
      if (textElements.length === 0) {
        return <span key={index}>{text}</span>;
      }

      return <span key={index}>{textElements}</span>;
    
    case 'rich-text':
      const textContent = typeof part.content === 'string'
        ? part.content
        : JSON.stringify(part.content, null, 2);

      const mentionRegex = /@\[([^\]]+)\]\(([^:]+):([^)]+)\)/g;
      const elements = [];
      let lastIndex = 0;
      let match;

      while ((match = mentionRegex.exec(textContent)) !== null) {
        const [fullMatch, label, id] = match;
        const precedingText = textContent.slice(lastIndex, match.index);
        if (precedingText) {
          elements.push(<span key={`${index}-text-${lastIndex}`}>{precedingText}</span>);
        }
        elements.push(
          <span key={`${index}-mention-${id}`} className="bg-blue-100 text-blue-800 px-1 rounded">
            @{label}
          </span>
        );
        lastIndex = match.index + fullMatch.length;
      }

      const remainingText = textContent.slice(lastIndex);
      if (remainingText) {
        elements.push(<span key={`${index}-text-${lastIndex}`}>{remainingText}</span>);
      }

      return <div key={index} className="whitespace-pre-wrap">{elements}</div>;
    
    case 'tool-invocation':
      return (
        <div
          key={index}
          className="mt-2 p-2 border rounded-lg bg-muted"
        >
          <div className="font-semibold">
            {part.toolInvocation?.toolName}
          </div>
          <pre className="text-xs whitespace-pre-wrap">
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