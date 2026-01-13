import React, { memo, useMemo } from 'react';

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
import { TaskRenderer } from './TaskRenderer';



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

// Tool name mapping (moved outside component)
const TOOL_NAME_MAP: Record<string, string> = {
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

type ToolOutputType = React.ReactNode | string | Record<string, unknown>;

// Internal renderer component with hooks
const ToolCallRendererInternal: React.FC<{ part: ToolPart; toolName: string }> = memo(function ToolCallRendererInternal({ part, toolName }) {
  const state = part.state || 'input-available';
  const input = part.input;
  const output = part.output;
  const error = part.errorText;

  // Map state to ToolHeader valid states
  const toolState = useMemo((): "input-streaming" | "input-available" | "output-available" | "output-error" => {
    switch (state) {
      case 'input-streaming': return 'input-streaming';
      case 'input-available': return 'input-available';
      case 'output-available': return 'output-available';
      case 'output-error': return 'output-error';
      case 'done': return 'output-available';
      case 'streaming': return 'input-streaming';
      default: return 'input-available';
    }
  }, [state]);

  // Memoize parsed input to avoid re-parsing on each render
  const parsedInput = useMemo(() => safeJsonParse(input), [input]);

  // Memoize formatted tool name
  const formattedToolName = useMemo(() => {
    return TOOL_NAME_MAP[toolName] || toolName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }, [toolName]);

  // Memoize descriptive title to avoid re-parsing input
  const descriptiveTitle = useMemo(() => {
    if (!parsedInput) return formattedToolName;

    const params = parsedInput as Record<string, unknown>;

    // File-based tools
    if (['read_page', 'replace_lines', 'list_pages'].includes(toolName)) {
      if (params.title) return `${formattedToolName}: "${params.title}"`;
      if (params.dir) return `${formattedToolName}: ${params.dir}`;
    }

    // Title-based tools
    if (['create_page', 'move_page'].includes(toolName)) {
      if (params.title) return `${formattedToolName}: "${params.title}"`;
      if (params.name) return `${formattedToolName}: "${params.name}"`;
    }

    // Rename uses currentTitle for display (title is the new name)
    if (toolName === 'rename_page') {
      if (params.currentTitle) return `${formattedToolName}: "${params.currentTitle}"`;
    }

    // Trash/Restore
    if (['trash', 'restore'].includes(toolName)) {
      if (params.title || params.name) return `${formattedToolName}: "${params.title || params.name}"`;
    }

    // Drive-based tools - show which drive
    if (['list_pages', 'list_trash'].includes(toolName)) {
      if (params.driveSlug) return `${formattedToolName}: "${params.driveSlug}"`;
    }

    // Drive creation
    if (toolName === 'create_drive') {
      if (params.name) return `${formattedToolName}: "${params.name}"`;
    }

    // Drive rename - show current name
    if (toolName === 'rename_drive') {
      if (params.currentName) return `${formattedToolName}: "${params.currentName}"`;
    }

    return formattedToolName;
  }, [parsedInput, formattedToolName, toolName]);

  // Memoize parsed output to avoid re-parsing on each render
  const parsedOutput = useMemo(() => {
    if (!output) return null;
    try {
      return typeof output === 'string' ? JSON.parse(output) : output;
    } catch {
      return null;
    }
  }, [output]);

  // Memoize output content to avoid recreating JSX on each render
  const outputContent = useMemo((): ToolOutputType | null => {
    if (!output) return null;

    if (parsedOutput) {
      if (toolName === 'list_pages' && parsedOutput.tree) {
        return <FileTreeRenderer tree={parsedOutput.tree} />;
      }

      if (toolName === 'read_page' && parsedOutput.content) {
        return (
          <DocumentRenderer
            title={parsedOutput.title || parsedOutput.path || 'Document'}
            content={parsedOutput.content}
            language={inferLanguage(parsedOutput.path)}
            description={parsedOutput.lineCount !== undefined ? `${parsedOutput.lineCount} lines` : undefined}
          />
        );
      }

      if (toolName === 'replace_lines' && parsedOutput.content) {
        return (
          <DocumentRenderer
            title={parsedOutput.title || parsedOutput.path || "Modified File"}
            content={parsedOutput.content}
            language={inferLanguage(parsedOutput.path)}
            description={parsedOutput.lineCount !== undefined ? `${parsedOutput.lineCount} lines` : "Updated Content"}
          />
        );
      }

      // Generic JSON output for others
      return typeof output === 'string' ? output : JSON.stringify(parsedOutput, null, 2);
    }

    return String(output);
  }, [output, parsedOutput, toolName]);

  return (
    <Tool className="my-2">
      <ToolHeader
        title={descriptiveTitle}
        type={`tool-${toolName}`}
        state={toolState}
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
});

export const ToolCallRenderer: React.FC<ToolCallRendererProps> = memo(function ToolCallRenderer({ part }) {
  const toolName = part.toolName || part.type?.replace('tool-', '') || 'unknown_tool';

  // Task management tools - render with expandable summary
  if (toolName === 'update_task') {
    return <TaskRenderer part={part} />;
  }

  // Ask Agent tool - render with dedicated conversation UI
  if (toolName === 'ask_agent') {
    return <PageAgentConversationRenderer part={part} />;
  }

  return <ToolCallRendererInternal part={part} toolName={toolName} />;
});
