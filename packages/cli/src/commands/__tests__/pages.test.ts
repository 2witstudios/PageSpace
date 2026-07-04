import { describe, expect, it, vi } from 'vitest';
import {
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  pagesCreateHandler,
  pagesListHandler,
  pagesMoveHandler,
  pagesReadDetailsHandler,
  pagesRenameHandler,
  pagesRestoreHandler,
  pagesTrashHandler,
  pagesTreeHandler,
  parseArgv,
} from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

/**
 * Mirrors what the router hands a handler: `parseArgv` only passes an
 * unrecognized flag (e.g. `--drive`) through into `args` once at least one
 * positional token has been seen (there is no command yet to hand it to
 * otherwise) — in real usage that's always true by the time a handler runs,
 * since the resource/verb path segments precede it. `__cmd__` stands in for
 * that already-stripped path prefix and is sliced back off below.
 */
function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const LIST_RESULT = {
  mode: 'ls' as const,
  driveName: 'Engineering',
  driveSlug: 'engineering',
  location: '/engineering',
  breadcrumb: [],
  pages: [
    { id: 'pg_root_1', title: 'Design Docs', type: 'FOLDER' as const, hasChildren: true, isTaskLinked: false },
    { id: 'pg_nested_1', title: 'RFC-1', type: 'DOCUMENT' as const, hasChildren: false, isTaskLinked: false },
  ],
  count: 2,
  totalInDrive: 2,
};

const DIRECT_RESULT = {
  ...LIST_RESULT,
  pages: [{ id: 'pg_root_1', title: 'Design Docs', type: 'FOLDER' as const, hasChildren: true, isTaskLinked: false }],
  count: 1,
};

const PAGE = {
  id: 'pg_1',
  title: 'RFC-1',
  type: 'DOCUMENT' as const,
  content: null,
  contentMode: 'markdown' as const,
  parentId: null,
  driveId: 'drv_1',
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  revision: 1,
  stateHash: null,
  isTrashed: false,
  trashedAt: null,
  aiProvider: null,
  aiModel: null,
  systemPrompt: null,
  enabledTools: null,
  isPaginated: null,
};

describe('pagesListHandler', () => {
  it('requires --drive: exits 2 and never calls the SDK without it', async () => {
    const list = vi.fn(async () => LIST_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { list } }) });

    const code = await pagesListHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(list).not.toHaveBeenCalled();
  });

  it('calls pages.list with driveId and optional parentId', async () => {
    const list = vi.fn(async () => LIST_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { list } }) });

    const code = await pagesListHandler(ctx, commandIntent(['pg_parent', '--drive', 'drv_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(list).toHaveBeenCalledWith({ driveId: 'drv_1', parentId: 'pg_parent', ls: true });
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { list: async () => LIST_RESULT } }) });

    await pagesListHandler(ctx, commandIntent(['--drive', 'drv_1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(LIST_RESULT);
  });

  it('renders type and id for each page in human mode', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { list: async () => LIST_RESULT } }) });

    await pagesListHandler(ctx, commandIntent(['--drive', 'drv_1']));

    const output = stdout.lines.join('');
    expect(output).toContain('FOLDER');
    expect(output).toContain('pg_root_1');
    expect(output).toContain('DOCUMENT');
    expect(output).toContain('pg_nested_1');
  });
});

describe('pagesTreeHandler', () => {
  it('requires --drive: exits 2 and never calls the SDK without it', async () => {
    const list = vi.fn(async () => LIST_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { list } }) });

    const code = await pagesTreeHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(list).not.toHaveBeenCalled();
  });

  it('--json makes exactly one recursive call and emits exactly its raw response', async () => {
    const list = vi.fn(async () => LIST_RESULT);
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { list } }) });

    const code = await pagesTreeHandler(ctx, commandIntent(['--drive', 'drv_1', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ driveId: 'drv_1', parentId: undefined, recursive: true, ls: true });
    expect(JSON.parse(stdout.lines.join(''))).toEqual(LIST_RESULT);
  });

  it('human mode fetches both recursive and direct listings and indents nested pages', async () => {
    const list = vi.fn(async (input: { recursive?: boolean }) => (input.recursive ? LIST_RESULT : DIRECT_RESULT));
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { list } }) });

    const code = await pagesTreeHandler(ctx, commandIntent(['--drive', 'drv_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledWith({ driveId: 'drv_1', parentId: undefined, recursive: true, ls: true });
    expect(list).toHaveBeenCalledWith({ driveId: 'drv_1', parentId: undefined, recursive: false, ls: true });

    const lines = stdout.lines.join('').split('\n').filter(Boolean);
    const rootLine = lines.find((line) => line.includes('pg_root_1'));
    const nestedLine = lines.find((line) => line.includes('pg_nested_1'));
    expect(rootLine).toBeDefined();
    expect(nestedLine).toBeDefined();
    expect(nestedLine!.length - nestedLine!.trimStart().length).toBeGreaterThan(rootLine!.length - rootLine!.trimStart().length);
  });
});

describe('pagesReadDetailsHandler', () => {
  it('calls pages.details with pageId', async () => {
    const details = vi.fn(async () => ({ ...PAGE, children: [], messages: [] }));
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { details } }) });

    const code = await pagesReadDetailsHandler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(details).toHaveBeenCalledWith({ pageId: 'pg_1' });
  });

  it('exits 2 with a usage error when pageId is missing', async () => {
    const details = vi.fn(async () => ({ ...PAGE, children: [], messages: [] }));
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { details } }) });

    const code = await pagesReadDetailsHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(details).not.toHaveBeenCalled();
  });

  it('--json emits exactly the SDK response', async () => {
    const value = { ...PAGE, children: [], messages: [] };
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { details: async () => value } }) });

    await pagesReadDetailsHandler(ctx, commandIntent(['pg_1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(value);
  });
});

describe('pagesCreateHandler', () => {
  it('requires --drive, title, and type', async () => {
    const create = vi.fn(async () => PAGE);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { create } }) });

    const code = await pagesCreateHandler(ctx, commandIntent(['Title Only']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an invalid page type as a usage error without calling the SDK', async () => {
    const create = vi.fn(async () => PAGE);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { create } }) });

    const code = await pagesCreateHandler(ctx, commandIntent(['RFC-1', 'NOT_A_TYPE', '--drive', 'drv_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(create).not.toHaveBeenCalled();
  });

  it('calls pages.create with driveId, title, type, and null parentId by default', async () => {
    const create = vi.fn(async () => PAGE);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { create } }) });

    const code = await pagesCreateHandler(ctx, commandIntent(['RFC-1', 'DOCUMENT', '--drive', 'drv_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(create).toHaveBeenCalledWith({ driveId: 'drv_1', title: 'RFC-1', type: 'DOCUMENT', parentId: null });
  });

  it('passes an explicit parentId through when given', async () => {
    const create = vi.fn(async () => PAGE);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { create } }) });

    await pagesCreateHandler(ctx, commandIntent(['RFC-1', 'DOCUMENT', 'pg_parent', '--drive', 'drv_1']));

    expect(create).toHaveBeenCalledWith({ driveId: 'drv_1', title: 'RFC-1', type: 'DOCUMENT', parentId: 'pg_parent' });
  });
});

describe('pagesRenameHandler', () => {
  it('calls pages.rename with pageId and title', async () => {
    const rename = vi.fn(async () => PAGE);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { rename } }) });

    const code = await pagesRenameHandler(ctx, commandIntent(['pg_1', 'New Title']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(rename).toHaveBeenCalledWith({ pageId: 'pg_1', title: 'New Title' });
  });

  it('exits 2 with a usage error when args are missing', async () => {
    const rename = vi.fn(async () => PAGE);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { rename } }) });

    const code = await pagesRenameHandler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('pagesMoveHandler', () => {
  it('calls pages.move with pageId, newParentId, and newPosition', async () => {
    const move = vi.fn(async () => ({ message: 'moved' }));
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { move } }) });

    const code = await pagesMoveHandler(ctx, commandIntent(['pg_1', 'pg_parent', '3']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(move).toHaveBeenCalledWith({ pageId: 'pg_1', newParentId: 'pg_parent', newPosition: 3 });
  });

  it('maps the "root" keyword newParentId to null', async () => {
    const move = vi.fn(async () => ({ message: 'moved' }));
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { move } }) });

    await pagesMoveHandler(ctx, commandIntent(['pg_1', 'root', '0']));

    expect(move).toHaveBeenCalledWith({ pageId: 'pg_1', newParentId: null, newPosition: 0 });
  });

  it('exits 2 with a usage error for a non-numeric position, never calling the SDK', async () => {
    const move = vi.fn(async () => ({ message: 'moved' }));
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { move } }) });

    const code = await pagesMoveHandler(ctx, commandIntent(['pg_1', 'pg_parent', 'not-a-number']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(move).not.toHaveBeenCalled();
  });
});

describe('pagesTrashHandler (destructive)', () => {
  it('with --yes in a non-TTY session: trashes without prompting, trash_children defaults false', async () => {
    const trash = vi.fn(async () => ({ message: 'trashed' }));
    const prompt = vi.fn(async () => 'irrelevant');
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { trash } }), isTTY: false, prompt });

    const code = await pagesTrashHandler(ctx, commandIntent(['pg_1', '--yes']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(prompt).not.toHaveBeenCalled();
    expect(trash).toHaveBeenCalledWith({ pageId: 'pg_1', trash_children: false });
  });

  it('maps --all to trash_children: true', async () => {
    const trash = vi.fn(async () => ({ message: 'trashed' }));
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { trash } }), isTTY: false });

    await pagesTrashHandler(ctx, commandIntent(['pg_1', '--yes', '--all']));

    expect(trash).toHaveBeenCalledWith({ pageId: 'pg_1', trash_children: true });
  });

  it('fails closed in a non-TTY session without --yes, never calling trash', async () => {
    const trash = vi.fn(async () => ({ message: 'trashed' }));
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { trash } }), isTTY: false, stderr });

    const code = await pagesTrashHandler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(trash).not.toHaveBeenCalled();
    expect(stderr.lines.join('')).toMatch(/--yes/);
  });

  it('in a TTY session without --yes, prompts and trashes on an affirmative answer', async () => {
    const trash = vi.fn(async () => ({ message: 'trashed' }));
    const prompt = vi.fn(async () => 'y');
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { trash } }), isTTY: true, prompt });

    const code = await pagesTrashHandler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(prompt).toHaveBeenCalled();
    expect(trash).toHaveBeenCalledWith({ pageId: 'pg_1', trash_children: false });
  });

  it('in a TTY session without --yes, refuses on a declined answer', async () => {
    const trash = vi.fn(async () => ({ message: 'trashed' }));
    const prompt = vi.fn(async () => 'n');
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { trash } }), isTTY: true, prompt });

    const code = await pagesTrashHandler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(trash).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when pageId is missing', async () => {
    const trash = vi.fn(async () => ({ message: 'trashed' }));
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { trash } }) });

    const code = await pagesTrashHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(trash).not.toHaveBeenCalled();
  });
});

describe('pagesRestoreHandler', () => {
  it('calls pages.restore with pageId (not destructive: no confirmation needed)', async () => {
    const restore = vi.fn(async () => ({ message: 'restored' }));
    const prompt = vi.fn(async () => '');
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { restore } }), isTTY: true, prompt });

    const code = await pagesRestoreHandler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(restore).toHaveBeenCalledWith({ pageId: 'pg_1' });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when pageId is missing', async () => {
    const restore = vi.fn(async () => ({ message: 'restored' }));
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { restore } }) });

    const code = await pagesRestoreHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(restore).not.toHaveBeenCalled();
  });
});
