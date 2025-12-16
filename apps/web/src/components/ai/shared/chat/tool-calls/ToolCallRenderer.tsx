import React from 'react';

import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolOutput,
  ToolInput
} from '@/components/ai/ui/tool';
import { PageAgentConversationRenderer } from '@/components/ai/page-agents';
import { FileTreeRenderer } from './FileTreeRenderer';
import { DocumentRenderer } from './DocumentRenderer';



interface ToolPart {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

interface ToolCallRendererProps {
  part: ToolPart;
}

/**
 * Renders PageSpace tool calls using a standardized Tool UI.
 * Addresses ambiguity by extracting target filenames/titles from input.
 */
// Helper for safe JSON parsing
const safeJsonParse = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return { raw: value };
    }
  }
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
};

// Helper to infer language from file path
const inferLanguage = (path?: string): string => {
  if (!path) return 'plaintext';
  const ext = path.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    'ts': 'typescript', 'tsx': 'typescript',
    'js': 'javascript', 'jsx': 'javascript',
    'py': 'python', 'md': 'markdown',
    'json': 'json', 'css': 'css', 'html': 'html',
    'yml': 'yaml', 'yaml': 'yaml',
    'sh': 'shell', 'bash': 'shell',
    'sql': 'sql', 'xml': 'xml',
    'go': 'go', 'rs': 'rust',
    'java': 'java', 'c': 'c', 'cpp': 'cpp',
    'rb': 'ruby', 'php': 'php'
  };
  return langMap[ext || ''] || 'plaintext';
};

type ToolOutputType = React.ReactNode | string | Record<string, unknown>;

export const ToolCallRenderer: React.FC<ToolCallRendererProps> = ({ part }) => {
  const toolName = part.toolName || part.type?.replace('tool-', '') || 'unknown_tool';
  const state = part.state || 'input-available';
  const input = part.input;
  const output = part.output;
  const error = part.errorText;

  // Map state to ToolHeader valid states
  const getToolState = (): "input-streaming" | "input-available" | "output-available" | "output-error" => {
    switch (state) {
      case 'input-streaming': return 'input-streaming';
      case 'input-available': return 'input-available';
      case 'output-available': return 'output-available';
      case 'output-error': return 'output-error';
      case 'done': return 'output-available'; // Map done to output-available
      case 'streaming': return 'input-streaming'; // Map streaming to input-streaming
      default: return 'input-available';
    }
  };

  // Task management tools - rendered as aggregated component in ChatMessagesArea
  // Return null here to avoid duplicate rendering
  if (['update_task'].includes(toolName)) {
    return null;
  }

  // Ask Agent tool - render with dedicated conversation UI
  if (toolName === 'ask_agent') {
    return <PageAgentConversationRenderer part={part} />;
  }

  // Helper: Format Tool Name
  const formatToolName = () => {
    const nameMap: Record<string, string> = {
      'ask_agent': 'Ask Agent',
      'list_drives': 'List Drives',
      'list_pages': 'List Pages',
      'read_page': 'Read Page',
      'replace_lines': 'Replace Lines',
      'create_page': 'Create Page',
      'rename_page': 'Rename Page',
      'trash': 'Trash',
      'restore': 'Restore',
      'move_page': 'Move Page',
      'list_trash': 'List Trash'
    };
    return nameMap[toolName] || toolName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  };

  // AMBIGUITY FIX: Parse input to get a descriptive header title
  const getDescriptiveTitle = () => {
    const base = formatToolName();
    if (!input) return base;

    try {
      const params = typeof input === 'string' ? JSON.parse(input) : input;

      // File-based tools
      if (['read_page', 'replace_lines', 'list_pages'].includes(toolName)) {
        if (params.path) return `${base}: ${params.path}`;
        if (params.dir) return `${base}: ${params.dir}`;
      }

      // Title-based tools
      if (['create_page', 'rename_page', 'move_page'].includes(toolName)) {
        if (params.title) return `${base}: "${params.title}"`;
        if (params.name) return `${base}: "${params.name}"`;
      }

      // Trash/Restore
      if (['trash', 'restore'].includes(toolName)) {
        if (params.title || params.name) return `${base}: "${params.title || params.name}"`;
      }

      return base;
    } catch {
      return base;
    }
  };

  // Render content based on tool type and completion status
  const getOutputContent = () => {
    // If we have output, render the result view
    if (output) {
      try {
        const result = typeof output === 'string' ? JSON.parse(output) : output;

        if (toolName === 'list_pages' && result.tree) {
          return <FileTreeRenderer tree={result.tree} />;
        }

        if (toolName === 'read_page' && result.content) {
          return (
            <DocumentRenderer
              title={result.title || result.path || 'Document'}
              content={result.content}
              language={inferLanguage(result.path)}
              description={result.lineCount !== undefined ? `${result.lineCount} lines` : undefined}
            />
          );
        }

        if (toolName === 'replace_lines' && result.content) {
          return (
            <DocumentRenderer
              title={result.title || result.path || "Modified File"}
              content={result.content}
              language={inferLanguage(result.path)}
              description={result.lineCount !== undefined ? `${result.lineCount} lines` : "Updated Content"}
            />
          );
        }

        // Generic JSON output for others
        return typeof output === 'string' ? output : JSON.stringify(result, null, 2);
      } catch {
        return String(output);
      }
    }
    return null;
  };

  const outputContent = getOutputContent();
  const parsedInput = safeJsonParse(input);

  return (
    <Tool className="my-2">
      <ToolHeader
        title={getDescriptiveTitle()}
        type={`tool-${toolName}`}
        state={getToolState()}
      />
      <ToolContent>
        {!!input && parsedInput && (
          <ToolInput input={parsedInput} />
        )}
        {(outputContent || error) && (
          <ToolOutput output={outputContent as ToolOutputType} errorText={error} />
        )}
      </ToolContent>
    </Tool>
  );
};
