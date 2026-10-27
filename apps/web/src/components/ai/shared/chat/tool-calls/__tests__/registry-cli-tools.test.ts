import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import { toolRenderers, CLI_TOOL_NAMES } from '../registry';
import { RichDiffRenderer } from '../RichDiffRenderer';

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

  it('write/edit: return null when output is null (tool still pending — no premature success card)', () => {
    expect(toolRenderers['write'](makeCtx('write', { file_path: 'foo.ts' }, null))).toBeNull();
    expect(toolRenderers['edit'](makeCtx('edit', { file_path: 'foo.ts' }, null))).toBeNull();
  });

  it('write/edit: return non-null success card when output is available', () => {
    expect(toolRenderers['write'](makeCtx('write', { file_path: 'foo.ts' }, 'ok'))).not.toBeNull();
    expect(toolRenderers['edit'](makeCtx('edit', { file_path: 'foo.ts' }, 'ok'))).not.toBeNull();
  });

  it('write/edit: upgrade to a diff view when the payload carries oldContent/newContent', () => {
    const ctxWithDiff = (toolName: string): Parameters<(typeof toolRenderers)[string]>[0] => ({
      toolName,
      parsedInput: { file_path: 'foo.ts' },
      parsedOutput: { oldContent: 'old text', newContent: 'new text' },
      output: 'ok',
    });

    const writeResult = toolRenderers['write'](ctxWithDiff('write'));
    const editResult = toolRenderers['edit'](ctxWithDiff('edit'));
    expect(isValidElement(writeResult) && writeResult.type).toBe(RichDiffRenderer);
    expect(isValidElement(editResult) && editResult.type).toBe(RichDiffRenderer);
  });

  it('write/edit: fall back to plain success card when oldContent/newContent are absent (today\'s pagespace-cli payload)', () => {
    // pagespace-cli currently returns a bare "ok" string, so parsedOutput is {}
    // — this asserts the fallback keeps working until the CLI reports content.
    expect(toolRenderers['write'](makeCtx('write', { file_path: 'foo.ts' }, 'ok'))).not.toBeNull();
    expect(toolRenderers['edit'](makeCtx('edit', { file_path: 'foo.ts' }, 'ok'))).not.toBeNull();
  });

  it('write/edit: do not upgrade to a diff view when the payload reports failure, even with content fields present', () => {
    const ctxFailedWithContent = (toolName: string): Parameters<(typeof toolRenderers)[string]>[0] => ({
      toolName,
      parsedInput: { file_path: 'foo.ts' },
      parsedOutput: { success: false, oldContent: 'old text', newContent: 'new text' },
      output: 'error',
    });

    const writeResult = toolRenderers['write'](ctxFailedWithContent('write'));
    const editResult = toolRenderers['edit'](ctxFailedWithContent('edit'));
    expect(isValidElement(writeResult) && writeResult.type).not.toBe(RichDiffRenderer);
    expect(isValidElement(editResult) && editResult.type).not.toBe(RichDiffRenderer);
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
