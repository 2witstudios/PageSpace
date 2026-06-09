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

  it('Read: returns null when output is not a string', () => {
    const result = toolRenderers['Read'](makeCtx('Read', { path: 'foo.ts' }, null));
    expect(result).toBeNull();
  });

  it('Read: returns non-null node for valid string output (pi uses path key)', () => {
    const result = toolRenderers['Read'](makeCtx('Read', { path: 'foo.ts' }, 'line 1\nline 2'));
    expect(result).not.toBeNull();
  });

  it('Read: falls back to file_path key when path is absent', () => {
    const result = toolRenderers['Read'](makeCtx('Read', { file_path: 'bar.ts' }, 'content'));
    expect(result).not.toBeNull();
  });

  it('Bash: returns null when both command and output are absent', () => {
    const result = toolRenderers['Bash'](makeCtx('Bash', {}, null));
    expect(result).toBeNull();
  });

  it('Bash: returns non-null node when command is present', () => {
    const result = toolRenderers['Bash'](makeCtx('Bash', { command: 'ls -la' }, 'foo.ts\nbar.ts'));
    expect(result).not.toBeNull();
  });

  it('Glob: returns null when output is not a string', () => {
    const result = toolRenderers['Glob'](makeCtx('Glob', { pattern: '**/*.ts' }, null));
    expect(result).toBeNull();
  });

  it('Glob: returns non-null node for valid string output', () => {
    const result = toolRenderers['Glob'](makeCtx('Glob', { pattern: '**/*.ts' }, 'src/foo.ts\nsrc/bar.ts'));
    expect(result).not.toBeNull();
  });

  it('Grep: returns null when output is not a string', () => {
    const result = toolRenderers['Grep'](makeCtx('Grep', { pattern: 'TODO' }, null));
    expect(result).toBeNull();
  });

  it('Grep: returns non-null node for valid string output', () => {
    const result = toolRenderers['Grep'](makeCtx('Grep', { pattern: 'TODO' }, 'foo.ts:42: // TODO fix'));
    expect(result).not.toBeNull();
  });

  it('Write/Edit/MultiEdit: return non-null nodes even with null output', () => {
    expect(toolRenderers['Write'](makeCtx('Write', { file_path: 'foo.ts' }, null))).not.toBeNull();
    expect(toolRenderers['Edit'](makeCtx('Edit', { file_path: 'foo.ts' }, null))).not.toBeNull();
    expect(toolRenderers['MultiEdit'](makeCtx('MultiEdit', { file_path: 'foo.ts' }, null))).not.toBeNull();
  });
});
