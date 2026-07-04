import { describe, expect, it, vi } from 'vitest';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, parseArgv } from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';
import { createPagesExportHandler } from '../export.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

function fakeDeps(overrides: Partial<{ fileExists: (path: string) => Promise<boolean>; writeFile: (path: string, content: string) => Promise<void> }> = {}) {
  return {
    fileExists: vi.fn(async () => false),
    writeFile: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('createPagesExportHandler', () => {
  it('exits 2 with a usage error when pageId is missing', async () => {
    const pageMarkdown = vi.fn(async () => '# doc');
    const deps = fakeDeps();
    const handler = createPagesExportHandler(deps);
    const ctx = createFakeContext({ sdk: fakeSdk({ export: { pageMarkdown } }) });

    const code = await handler(ctx, commandIntent(['--format', 'md', '--out', '-']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(pageMarkdown).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error for an invalid --format, never calling the SDK', async () => {
    const pageMarkdown = vi.fn(async () => '# doc');
    const deps = fakeDeps();
    const handler = createPagesExportHandler(deps);
    const ctx = createFakeContext({ sdk: fakeSdk({ export: { pageMarkdown } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--format', 'pdf', '--out', '-']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(pageMarkdown).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when --out is missing', async () => {
    const pageMarkdown = vi.fn(async () => '# doc');
    const deps = fakeDeps();
    const handler = createPagesExportHandler(deps);
    const ctx = createFakeContext({ sdk: fakeSdk({ export: { pageMarkdown } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--format', 'md']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(pageMarkdown).not.toHaveBeenCalled();
  });

  it('--format md calls export.pageMarkdown and "-" writes the raw text to stdout, nothing else', async () => {
    const pageMarkdown = vi.fn(async () => '# Hello World');
    const sheetCsv = vi.fn(async () => 'a,b');
    const deps = fakeDeps();
    const stdout = createRecordingSink();
    const handler = createPagesExportHandler(deps);
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ export: { pageMarkdown, sheetCsv } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--format', 'md', '--out', '-']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(pageMarkdown).toHaveBeenCalledWith({ pageId: 'pg_1' });
    expect(sheetCsv).not.toHaveBeenCalled();
    expect(stdout.lines.join('')).toBe('# Hello World');
  });

  it('--format csv calls export.sheetCsv', async () => {
    const pageMarkdown = vi.fn(async () => '# Hello World');
    const sheetCsv = vi.fn(async () => 'a,b\n1,2');
    const deps = fakeDeps();
    const stdout = createRecordingSink();
    const handler = createPagesExportHandler(deps);
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ export: { pageMarkdown, sheetCsv } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--format', 'csv', '--out', '-']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(sheetCsv).toHaveBeenCalledWith({ pageId: 'pg_1' });
    expect(pageMarkdown).not.toHaveBeenCalled();
    expect(stdout.lines.join('')).toBe('a,b\n1,2');
  });

  it('writes to a file path when --out is not "-", and prints nothing raw to stdout', async () => {
    const pageMarkdown = vi.fn(async () => '# Hello World');
    const deps = fakeDeps({ fileExists: vi.fn(async () => false) });
    const stdout = createRecordingSink();
    const handler = createPagesExportHandler(deps);
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ export: { pageMarkdown } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--format', 'md', '--out', '/tmp/doc.md']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(deps.writeFile).toHaveBeenCalledWith('/tmp/doc.md', '# Hello World');
    expect(stdout.lines.join('')).not.toContain('# Hello World');
  });

  it('refuses to overwrite an existing file without --force, never calling the SDK', async () => {
    const pageMarkdown = vi.fn(async () => '# Hello World');
    const deps = fakeDeps({ fileExists: vi.fn(async () => true) });
    const stderr = createRecordingSink();
    const handler = createPagesExportHandler(deps);
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ export: { pageMarkdown } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--format', 'md', '--out', '/tmp/doc.md']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(pageMarkdown).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(stderr.lines.join('')).toMatch(/--force/);
  });

  it('overwrites an existing file when --force is given', async () => {
    const pageMarkdown = vi.fn(async () => '# Hello World');
    const deps = fakeDeps({ fileExists: vi.fn(async () => true) });
    const handler = createPagesExportHandler(deps);
    const ctx = createFakeContext({ sdk: fakeSdk({ export: { pageMarkdown } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--format', 'md', '--out', '/tmp/doc.md', '--force']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(pageMarkdown).toHaveBeenCalledWith({ pageId: 'pg_1' });
    expect(deps.writeFile).toHaveBeenCalledWith('/tmp/doc.md', '# Hello World');
  });

  it('surfaces an SDK failure as a runtime error', async () => {
    const pageMarkdown = vi.fn(async () => {
      throw new Error('Markdown export is only available for DOCUMENT pages');
    });
    const deps = fakeDeps();
    const stderr = createRecordingSink();
    const handler = createPagesExportHandler(deps);
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ export: { pageMarkdown } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--format', 'md', '--out', '-']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Markdown export is only available for DOCUMENT pages');
  });
});
