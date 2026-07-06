import { describe, expect, it, vi } from 'vitest';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, parseArgv } from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';
import { createPagesReplaceLinesHandler, pagesReadHandler } from '../content.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const GENERIC_READ_RESULT = {
  pageId: 'pg_1',
  pageTitle: 'RFC-1',
  totalLines: 2,
  numberedLines: ['   1 | line one', '   2 | line two'],
  content: 'line one\nline two',
};

describe('pagesReadHandler', () => {
  it('exits 2 with a usage error when pageId is missing', async () => {
    const read = vi.fn(async () => GENERIC_READ_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { read } }) });

    const code = await pagesReadHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(read).not.toHaveBeenCalled();
  });

  it('calls pages.read with pageId only when no range is given', async () => {
    const read = vi.fn(async () => GENERIC_READ_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { read } }) });

    const code = await pagesReadHandler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(read).toHaveBeenCalledWith({ operation: 'read', pageId: 'pg_1', startLine: undefined, endLine: undefined });
  });

  it('passes --start/--end through as a numeric range', async () => {
    const read = vi.fn(async () => GENERIC_READ_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { read } }) });

    const code = await pagesReadHandler(ctx, commandIntent(['pg_1', '--start', '2', '--end', '5']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(read).toHaveBeenCalledWith({ operation: 'read', pageId: 'pg_1', startLine: 2, endLine: 5 });
  });

  it('rejects an out-of-order range as a usage error before any network call', async () => {
    const read = vi.fn(async () => GENERIC_READ_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { read } }) });

    const code = await pagesReadHandler(ctx, commandIntent(['pg_1', '--start', '5', '--end', '2']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a non-integer --start as a usage error before any network call', async () => {
    const read = vi.fn(async () => GENERIC_READ_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { read } }) });

    const code = await pagesReadHandler(ctx, commandIntent(['pg_1', '--start', 'nope']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(read).not.toHaveBeenCalled();
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { read: async () => GENERIC_READ_RESULT } }) });

    await pagesReadHandler(ctx, commandIntent(['pg_1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(GENERIC_READ_RESULT);
  });

  it('human mode renders numbered lines', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { read: async () => GENERIC_READ_RESULT } }) });

    await pagesReadHandler(ctx, commandIntent(['pg_1']));

    const output = stdout.lines.join('');
    expect(output).toContain('1 | line one');
    expect(output).toContain('2 | line two');
  });

  it('--raw prints exactly the content field, unnumbered', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { read: async () => GENERIC_READ_RESULT } }) });

    await pagesReadHandler(ctx, commandIntent(['pg_1', '--raw']));

    expect(stdout.lines.join('')).toBe('line one\nline two');
  });
});

describe('createPagesReplaceLinesHandler', () => {
  it('exits 2 with a usage error when pageId is missing, never reading input', async () => {
    const replaceLines = vi.fn(async () => ({ pageId: 'pg_1', pageTitle: null, totalLines: 2, numberedLines: [], operation: 'replace' as const, affectedLines: '1-2' }));
    const readStdin = vi.fn(async () => 'new content');
    const readFile = vi.fn(async () => 'file content');
    const handler = createPagesReplaceLinesHandler({ readStdin, readFile });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { replaceLines } }) });

    const code = await handler(ctx, commandIntent(['--start', '1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(readStdin).not.toHaveBeenCalled();
    expect(replaceLines).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when --start is missing, before reading any input', async () => {
    const replaceLines = vi.fn(async () => ({ pageId: 'pg_1', pageTitle: null, totalLines: 2, numberedLines: [], operation: 'replace' as const, affectedLines: '1' }));
    const readStdin = vi.fn(async () => 'new content');
    const readFile = vi.fn(async () => 'file content');
    const handler = createPagesReplaceLinesHandler({ readStdin, readFile });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { replaceLines } }) });

    const code = await handler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(readStdin).not.toHaveBeenCalled();
    expect(replaceLines).not.toHaveBeenCalled();
  });

  it('rejects an out-of-order range as a usage error before reading any input', async () => {
    const replaceLines = vi.fn(async () => ({ pageId: 'pg_1', pageTitle: null, totalLines: 2, numberedLines: [], operation: 'replace' as const, affectedLines: '1' }));
    const readStdin = vi.fn(async () => 'new content');
    const readFile = vi.fn(async () => 'file content');
    const handler = createPagesReplaceLinesHandler({ readStdin, readFile });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { replaceLines } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--start', '5', '--end', '2']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(readStdin).not.toHaveBeenCalled();
    expect(replaceLines).not.toHaveBeenCalled();
  });

  it('reads content from stdin by default and passes it through byte-exact, including trailing newlines', async () => {
    const replaceLines = vi.fn(async () => ({ pageId: 'pg_1', pageTitle: null, totalLines: 3, numberedLines: [], operation: 'replace' as const, affectedLines: '2' }));
    const readStdin = vi.fn(async () => 'replacement text\n\n');
    const readFile = vi.fn(async () => 'unused');
    const handler = createPagesReplaceLinesHandler({ readStdin, readFile });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { replaceLines } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--start', '2']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(readFile).not.toHaveBeenCalled();
    expect(replaceLines).toHaveBeenCalledWith({ operation: 'replace', pageId: 'pg_1', startLine: 2, endLine: undefined, content: 'replacement text\n\n' });
  });

  it('reads content from --file when given, byte-exact, never touching stdin', async () => {
    const replaceLines = vi.fn(async () => ({ pageId: 'pg_1', pageTitle: null, totalLines: 3, numberedLines: [], operation: 'replace' as const, affectedLines: '2-3' }));
    const readStdin = vi.fn(async () => 'should not be used');
    const readFile = vi.fn(async (path: string) => `content of ${path}`);
    const handler = createPagesReplaceLinesHandler({ readStdin, readFile });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { replaceLines } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--start', '2', '--end', '3', '--file', '/tmp/new.md']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(readStdin).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith('/tmp/new.md');
    expect(replaceLines).toHaveBeenCalledWith({ operation: 'replace', pageId: 'pg_1', startLine: 2, endLine: 3, content: 'content of /tmp/new.md' });
  });

  it('--json emits exactly the SDK response', async () => {
    const value = { pageId: 'pg_1', pageTitle: 'RFC-1', totalLines: 3, numberedLines: ['   1 | a'], operation: 'replace' as const, affectedLines: '1' };
    const stdout = createRecordingSink();
    const handler = createPagesReplaceLinesHandler({ readStdin: async () => 'a', readFile: async () => 'a' });
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { replaceLines: async () => value } }) });

    await handler(ctx, commandIntent(['pg_1', '--start', '1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(value);
  });

  it('surfaces an SDK failure as a runtime error', async () => {
    const replaceLines = vi.fn(async () => {
      throw new Error('409 revision conflict');
    });
    const stderr = createRecordingSink();
    const handler = createPagesReplaceLinesHandler({ readStdin: async () => 'a', readFile: async () => 'a' });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ pages: { replaceLines } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--start', '1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('409 revision conflict');
  });
});
