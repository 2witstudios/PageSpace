import { describe, expect, it, vi } from 'vitest';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, parseArgv, trashListHandler } from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

/**
 * Mirrors what the router hands a handler: `parseArgv` only passes an
 * unrecognized flag (e.g. `--drive`) through into `args` once at least one
 * positional token has been seen — in real usage that's always true by the
 * time a handler runs, since the resource/verb path precedes it. `__cmd__`
 * stands in for that already-stripped prefix and is sliced back off below.
 */
function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const TRASH_TREE = [
  {
    id: 'pg_1',
    title: 'Old Folder',
    type: 'FOLDER' as const,
    children: [{ id: 'pg_2', title: 'Old Doc', type: 'DOCUMENT' as const, children: [] }],
  },
];

describe('trashListHandler', () => {
  it('requires --drive: exits 2 and never calls the SDK without it', async () => {
    const listTrash = vi.fn(async () => TRASH_TREE);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { listTrash } }) });

    const code = await trashListHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(listTrash).not.toHaveBeenCalled();
  });

  it('calls pages.listTrash with driveId', async () => {
    const listTrash = vi.fn(async () => TRASH_TREE);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { listTrash } }) });

    const code = await trashListHandler(ctx, commandIntent(['--drive', 'drv_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(listTrash).toHaveBeenCalledWith({ driveId: 'drv_1' });
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { listTrash: async () => TRASH_TREE } }) });

    await trashListHandler(ctx, commandIntent(['--drive', 'drv_1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(TRASH_TREE);
  });

  it('renders the true nested depth in human mode (child indented deeper than parent)', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { listTrash: async () => TRASH_TREE } }) });

    await trashListHandler(ctx, commandIntent(['--drive', 'drv_1']));

    const lines = stdout.lines.join('').split('\n').filter(Boolean);
    const parentLine = lines.find((line) => line.includes('pg_1'));
    const childLine = lines.find((line) => line.includes('pg_2'));
    expect(parentLine).toBeDefined();
    expect(childLine).toBeDefined();
    expect(childLine!.length - childLine!.trimStart().length).toBeGreaterThan(parentLine!.length - parentLine!.trimStart().length);
  });

  it('reports an empty trash plainly', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { listTrash: async () => [] } }) });

    const code = await trashListHandler(ctx, commandIntent(['--drive', 'drv_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toMatch(/empty/i);
  });

  it('exits 1 and surfaces the server error on API failure', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({
      stderr,
      sdk: fakeSdk({
        pages: {
          listTrash: async () => {
            throw new Error('drive not found');
          },
        },
      }),
    });

    const code = await trashListHandler(ctx, commandIntent(['--drive', 'drv_missing']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('drive not found');
  });
});
