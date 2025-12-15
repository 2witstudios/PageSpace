import React from 'react';

import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolOutput,
  ToolInput
} from '@/components/ai/ui/tool';
import { TaskManagementToolRenderer } from './TaskManagementToolRenderer';
import { PageAgentConversationRenderer } from '@/components/ai/page-agents';
import { patch } from '@/lib/auth/auth-fetch';
import { FileTreePreview } from './views/FileTreePreview';
import { DocumentPreview } from './views/DocumentPreview';



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

  // Task management tools - render with dedicated renderer
  if (['update_task'].includes(toolName)) {
    return (
      <TaskManagementToolRenderer
        part={part}
        onTaskUpdate={async (taskId: string, newStatus) => {
          try {
            await patch(`/api/ai/tasks/${taskId}/status`, { status: newStatus });
          } catch (error) {
            console.error('Error updating task:', error);
          }
        }}
      />
    );
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
          return <FileTreePreview tree={result.tree} />;
        }

        if (toolName === 'read_page' && result.content) {
          return (
            <DocumentPreview
              title={result.title || result.path || 'Document'}
              content={result.content}
              language="typescript" // Infer or default
              description={`${result.lineCount} lines`}
            />
          );
        }

        if (toolName === 'replace_lines' && result.content) {
          return (
            <DocumentPreview
              title={result.title || "Modified File"}
              content={result.content}
              language="typescript"
              description="Updated Content"
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

  return (
    <Tool className="my-2">
      <ToolHeader
        title={getDescriptiveTitle()}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type={`tool-${toolName}` as any}
        state={getToolState()}
      // className requires removing icon prop or updating ToolHeader? 
      // ToolHeader in tool.tsx doesn't accept icon. It has hardcoded WrenchIcon.
      // I will ignore icon prop for now as it's not supported by standard ToolHeader.
      />
      <ToolContent>
        {!!input && (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          <ToolInput input={typeof input === 'string' ? JSON.parse(input) : input as any} />
        )}
        {(outputContent || error) && (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          <ToolOutput output={outputContent as any} errorText={error} />
        )}
      </ToolContent>
    </Tool>
  );
};
