import { describe, it, expect } from 'vitest';
import { dispatchToolCall, resolveIntegrationToolLabel, type DispatchToolPart } from '../tool-call-dispatch';

const TASK_TOOL_NAMES = new Set(['create_task', 'update_task']);

function part(overrides: Partial<DispatchToolPart>): DispatchToolPart {
  return { type: 'tool-read_page', ...overrides };
}

describe('dispatchToolCall', () => {
  it('hides tool_search calls', () => {
    const result = dispatchToolCall(part({ toolName: 'tool_search' }), TASK_TOOL_NAMES);
    expect(result.kind).toBe('hidden');
  });

  it('routes task tool names to the task branch', () => {
    const result = dispatchToolCall(part({ toolName: 'create_task' }), TASK_TOOL_NAMES);
    expect(result).toEqual({ kind: 'task', part: expect.objectContaining({ toolName: 'create_task' }) });
  });

  it('routes ask_agent to the agent branch', () => {
    const result = dispatchToolCall(part({ toolName: 'ask_agent' }), TASK_TOOL_NAMES);
    expect(result.kind).toBe('agent');
  });

  it('routes an ordinary tool to the generic branch with its own toolName', () => {
    const result = dispatchToolCall(part({ toolName: 'read_page' }), TASK_TOOL_NAMES);
    expect(result).toEqual({
      kind: 'generic',
      part: expect.objectContaining({ toolName: 'read_page' }),
      toolName: 'read_page',
    });
  });

  it('unwraps execute_tool to the inner tool_name and merges parameters into input', () => {
    const result = dispatchToolCall(
      part({
        toolName: 'execute_tool',
        input: JSON.stringify({ tool_name: 'read_page', parameters: { pageId: 'abc' } }),
      }),
      TASK_TOOL_NAMES,
    );
    expect(result.kind).toBe('generic');
    if (result.kind === 'generic') {
      expect(result.toolName).toBe('read_page');
      expect(result.part.input).toEqual({ pageId: 'abc' });
    }
  });

  it('hides execute_tool when the unwrapped inner tool is itself hidden', () => {
    const result = dispatchToolCall(
      part({
        toolName: 'execute_tool',
        input: JSON.stringify({ tool_name: 'tool_search', parameters: {} }),
      }),
      TASK_TOOL_NAMES,
    );
    expect(result.kind).toBe('hidden');
  });

  it('falls back to the raw type when toolName is missing', () => {
    const result = dispatchToolCall(part({ type: 'tool-glob_search', toolName: undefined }), TASK_TOOL_NAMES);
    expect(result.kind).toBe('generic');
    if (result.kind === 'generic') {
      expect(result.toolName).toBe('glob_search');
    }
  });
});

describe('resolveIntegrationToolLabel', () => {
  it('returns null for a non-integration tool name', () => {
    expect(resolveIntegrationToolLabel('read_page')).toBeNull();
  });
});
