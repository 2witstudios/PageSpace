import { describe, it, expect } from 'vitest';
import { toolRenderers, CLI_TOOL_NAMES } from '../registry';

const CLI_TOOLS = CLI_TOOL_NAMES;

const makeCtx = (
  toolName: string,
  input: Record<string, unknown> | null,
  output: unknown,
): Parameters<(typeof toolRenderers)[string]>[0] => ({
  toolName,
  parsedInput: input,
  parsedOutput: {},
  output,
});

describe('CLI tool renderers (pi)', () => {
  it('registers a renderer for each pi tool name', () => {
    for (const name of CLI_TOOLS) {
      expect(toolRenderers, `${name} should be in toolRenderers`).toHaveProperty(name);
    }
  });

  it('read: returns null when output is not a string', () => {
    const result = toolRenderers['read'](makeCtx('read', { path: 'foo.ts' }, null));
    expect(result).toBeNull();
  });

  it('read: returns non-null node for valid string output (pi uses path key)', () => {
    const result = toolRenderers['read'](makeCtx('read', { path: 'foo.ts' }, 'line 1\nline 2'));
    expect(result).not.toBeNull();
  });

  it('read: falls back to file_path key when path is absent', () => {
    const result = toolRenderers['read'](makeCtx('read', { file_path: 'bar.ts' }, 'content'));
    expect(result).not.toBeNull();
  });

  it('bash: returns null when both command and output are absent', () => {
    const result = toolRenderers['bash'](makeCtx('bash', {}, null));
    expect(result).toBeNull();
  });

  it('bash: returns non-null node when command is present', () => {
    const result = toolRenderers['bash'](makeCtx('bash', { command: 'ls -la' }, 'foo.ts\nbar.ts'));
    expect(result).not.toBeNull();
  });

  it('find: returns null when output is not a string', () => {
    const result = toolRenderers['find'](makeCtx('find', { pattern: '**/*.ts' }, null));
    expect(result).toBeNull();
  });

  it('find: returns non-null node for valid string output', () => {
    const result = toolRenderers['find'](makeCtx('find', { pattern: '**/*.ts' }, 'src/foo.ts\nsrc/bar.ts'));
    expect(result).not.toBeNull();
  });

  it('grep: returns null when output is not a string', () => {
    const result = toolRenderers['grep'](makeCtx('grep', { pattern: 'TODO' }, null));
    expect(result).toBeNull();
  });

  it('grep: returns non-null node for valid string output', () => {
    const result = toolRenderers['grep'](makeCtx('grep', { pattern: 'TODO' }, 'foo.ts:42: // TODO fix'));
    expect(result).not.toBeNull();
  });

  it('write/edit: return non-null nodes even with null output', () => {
    expect(toolRenderers['write'](makeCtx('write', { file_path: 'foo.ts' }, null))).not.toBeNull();
    expect(toolRenderers['edit'](makeCtx('edit', { file_path: 'foo.ts' }, null))).not.toBeNull();
  });

  it('ls: returns null when output is not a string', () => {
    const result = toolRenderers['ls'](makeCtx('ls', { path: '.' }, null));
    expect(result).toBeNull();
  });

  it('ls: returns non-null node for valid string output', () => {
    const result = toolRenderers['ls'](makeCtx('ls', { path: 'src/' }, 'foo.ts\nbar.ts'));
    expect(result).not.toBeNull();
  });
});
