import { describe, expect, it, vi } from 'vitest';
import {
  drivesCreateHandler,
  drivesListHandler,
  drivesRenameHandler,
  drivesRestoreHandler,
  drivesSetHomePageHandler,
  drivesTrashHandler,
  drivesUpdateContextHandler,
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  parseArgv,
} from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

const DRIVE = {
  id: 'drv_1',
  name: 'Engineering',
  slug: 'engineering',
  ownerId: 'user_1',
  kind: 'STANDARD' as const,
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isOwned: true,
  role: 'OWNER' as const,
  lastAccessedAt: null,
  homePageId: null,
};

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(argv);
  if (intent.kind !== 'command') throw new Error('expected command');
  return intent;
}

describe('drivesListHandler', () => {
  it('calls drives.list with includeTrash undefined by default', async () => {
    const list = vi.fn(async () => [DRIVE]);
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { list } }) });

    const code = await drivesListHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_SUCCESS);
    expect(list).toHaveBeenCalledWith({ includeTrash: undefined });
  });

  it('maps --all to includeTrash: true', async () => {
    const list = vi.fn(async () => [DRIVE]);
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { list } }) });

    await drivesListHandler(ctx, commandIntent(['--all']));

    expect(list).toHaveBeenCalledWith({ includeTrash: true });
  });

  it('renders human-readable output including id and name', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ drives: { list: async () => [DRIVE] } }) });

    await drivesListHandler(ctx, commandIntent([]));

    const output = stdout.lines.join('');
    expect(output).toContain(DRIVE.id);
    expect(output).toContain(DRIVE.name);
  });

  it('--json emits exactly the SDK response and nothing else on stdout', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ drives: { list: async () => [DRIVE] } }) });

    const code = await drivesListHandler(ctx, commandIntent(['--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual([DRIVE]);
  });

  it('exits 1 and surfaces the server error on API failure', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({
      stderr,
      sdk: fakeSdk({
        drives: {
          list: async () => {
            throw new Error('permission denied');
          },
        },
      }),
    });

    const code = await drivesListHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('permission denied');
  });
});

describe('drivesCreateHandler', () => {
  it('calls drives.create with the given name', async () => {
    const create = vi.fn(async () => DRIVE);
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { create } }) });

    const code = await drivesCreateHandler(ctx, commandIntent(['Engineering']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(create).toHaveBeenCalledWith({ name: 'Engineering' });
  });

  it('exits 2 with a usage error and never calls the SDK when name is missing', async () => {
    const create = vi.fn(async () => DRIVE);
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { create } }) });

    const code = await drivesCreateHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(create).not.toHaveBeenCalled();
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ drives: { create: async () => DRIVE } }) });

    await drivesCreateHandler(ctx, commandIntent(['Engineering', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(DRIVE);
  });
});

describe('drivesRenameHandler', () => {
  it('calls drives.rename with driveId and name', async () => {
    const rename = vi.fn(async () => ({ ...DRIVE, name: 'New Name' }));
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { rename } }) });

    const code = await drivesRenameHandler(ctx, commandIntent(['drv_1', 'New Name']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(rename).toHaveBeenCalledWith({ driveId: 'drv_1', name: 'New Name' });
  });

  it('exits 2 with a usage error when args are missing, never calling the SDK', async () => {
    const rename = vi.fn(async () => DRIVE);
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { rename } }) });

    const code = await drivesRenameHandler(ctx, commandIntent(['drv_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('drivesUpdateContextHandler', () => {
  it('calls drives.updateContext with driveId and drivePrompt', async () => {
    const updateContext = vi.fn(async () => ({ ...DRIVE, drivePrompt: 'be concise' }));
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { updateContext } }) });

    const code = await drivesUpdateContextHandler(ctx, commandIntent(['drv_1', 'be concise']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(updateContext).toHaveBeenCalledWith({ driveId: 'drv_1', drivePrompt: 'be concise' });
  });

  it('allows an empty string to clear the context prompt', async () => {
    const updateContext = vi.fn(async () => ({ ...DRIVE, drivePrompt: '' }));
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { updateContext } }) });

    const code = await drivesUpdateContextHandler(ctx, commandIntent(['drv_1', '']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(updateContext).toHaveBeenCalledWith({ driveId: 'drv_1', drivePrompt: '' });
  });

  it('exits 2 with a usage error when args are missing, never calling the SDK', async () => {
    const updateContext = vi.fn(async () => DRIVE);
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { updateContext } }) });

    const code = await drivesUpdateContextHandler(ctx, commandIntent(['drv_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(updateContext).not.toHaveBeenCalled();
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({
      stdout,
      sdk: fakeSdk({ drives: { updateContext: async () => ({ ...DRIVE, drivePrompt: 'be concise' }) } }),
    });

    await drivesUpdateContextHandler(ctx, commandIntent(['drv_1', 'be concise', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual({ ...DRIVE, drivePrompt: 'be concise' });
  });

  it('exits 1 and surfaces the server error on API failure', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({
      stderr,
      sdk: fakeSdk({
        drives: {
          updateContext: async () => {
            throw new Error('Requires owner/admin authority');
          },
        },
      }),
    });

    const code = await drivesUpdateContextHandler(ctx, commandIntent(['drv_1', 'be concise']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Requires owner/admin authority');
  });
});

describe('drivesSetHomePageHandler', () => {
  it('calls drives.setHomePage with driveId and pageId', async () => {
    const setHomePage = vi.fn(async () => ({ ...DRIVE, homePageId: 'pg_1' }));
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { setHomePage } }) });

    const code = await drivesSetHomePageHandler(ctx, commandIntent(['drv_1', 'pg_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(setHomePage).toHaveBeenCalledWith({ driveId: 'drv_1', homePageId: 'pg_1' });
  });

  it('--clear sends homePageId: null', async () => {
    const setHomePage = vi.fn(async () => ({ ...DRIVE, homePageId: null }));
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { setHomePage } }) });

    const code = await drivesSetHomePageHandler(ctx, commandIntent(['drv_1', '--clear']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(setHomePage).toHaveBeenCalledWith({ driveId: 'drv_1', homePageId: null });
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ drives: { setHomePage: async () => ({ ...DRIVE, homePageId: 'pg_1' }) } }) });

    await drivesSetHomePageHandler(ctx, commandIntent(['drv_1', 'pg_1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual({ ...DRIVE, homePageId: 'pg_1' });
  });

  it('exits 2 with a usage error when pageId/--clear is missing, never calling the SDK', async () => {
    const setHomePage = vi.fn(async () => DRIVE);
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { setHomePage } }) });

    const code = await drivesSetHomePageHandler(ctx, commandIntent(['drv_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(setHomePage).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when driveId is missing', async () => {
    const setHomePage = vi.fn(async () => DRIVE);
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { setHomePage } }) });

    const code = await drivesSetHomePageHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(setHomePage).not.toHaveBeenCalled();
  });

  it('exits 1 and surfaces the server error on API failure', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({
      stderr,
      sdk: fakeSdk({
        drives: {
          setHomePage: async () => {
            throw new Error('Home page must be a non-trashed page in this drive');
          },
        },
      }),
    });

    const code = await drivesSetHomePageHandler(ctx, commandIntent(['drv_1', 'pg_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Home page must be a non-trashed page in this drive');
  });

  it('--clear and --json combine correctly: sends homePageId: null and emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({
      stdout,
      sdk: fakeSdk({ drives: { setHomePage: async () => ({ ...DRIVE, homePageId: null }) } }),
    });

    const code = await drivesSetHomePageHandler(ctx, commandIntent(['drv_1', '--clear', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual({ ...DRIVE, homePageId: null });
  });
});

describe('drivesTrashHandler (destructive)', () => {
  function ctxWith(overrides: { list?: () => Promise<unknown>; trash?: () => Promise<unknown> }, extra: Partial<Parameters<typeof createFakeContext>[0]> = {}) {
    return createFakeContext({
      sdk: fakeSdk({
        drives: {
          list: overrides.list ?? (async () => [DRIVE]),
          trash: overrides.trash ?? (async () => ({ success: true })),
        },
      }),
      ...extra,
    });
  }

  it('with --yes in a non-TTY session: looks up the drive, then trashes without prompting', async () => {
    const list = vi.fn(async () => [DRIVE]);
    const trash = vi.fn(async () => ({ success: true }));
    const prompt = vi.fn(async () => 'irrelevant');
    const ctx = ctxWith({ list, trash }, { isTTY: false, prompt });

    const code = await drivesTrashHandler(ctx, commandIntent(['drv_1', '--yes']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(list).toHaveBeenCalledWith({});
    expect(prompt).not.toHaveBeenCalled();
    expect(trash).toHaveBeenCalledWith({ driveId: 'drv_1', confirmDriveName: 'Engineering' });
  });

  it('fails closed in a non-TTY session without --yes, never calling trash', async () => {
    const trash = vi.fn(async () => ({ success: true }));
    const stderr = createRecordingSink();
    const ctx = ctxWith({ trash }, { isTTY: false, stderr });

    const code = await drivesTrashHandler(ctx, commandIntent(['drv_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(trash).not.toHaveBeenCalled();
    expect(stderr.lines.join('')).toMatch(/--yes/);
  });

  it('in a TTY session without --yes, prompts to type the drive name and trashes on a correct answer', async () => {
    const trash = vi.fn(async () => ({ success: true }));
    const prompt = vi.fn(async () => 'Engineering');
    const ctx = ctxWith({ trash }, { isTTY: true, prompt });

    const code = await drivesTrashHandler(ctx, commandIntent(['drv_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('Engineering'));
    expect(trash).toHaveBeenCalledWith({ driveId: 'drv_1', confirmDriveName: 'Engineering' });
  });

  it('in a TTY session without --yes, refuses to trash when the typed name does not match', async () => {
    const trash = vi.fn(async () => ({ success: true }));
    const prompt = vi.fn(async () => 'wrong name');
    const stderr = createRecordingSink();
    const ctx = ctxWith({ trash }, { isTTY: true, prompt, stderr });

    const code = await drivesTrashHandler(ctx, commandIntent(['drv_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(trash).not.toHaveBeenCalled();
  });

  it('exits 1 without calling trash when the drive is not found in drives.list', async () => {
    const trash = vi.fn(async () => ({ success: true }));
    const stderr = createRecordingSink();
    const ctx = ctxWith({ list: async () => [], trash }, { isTTY: false, stderr });

    const code = await drivesTrashHandler(ctx, commandIntent(['drv_missing', '--yes']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(trash).not.toHaveBeenCalled();
    expect(stderr.lines.join('')).toContain('drv_missing');
  });

  it('exits 2 with a usage error when driveId is missing', async () => {
    const trash = vi.fn(async () => ({ success: true }));
    const ctx = ctxWith({ trash });

    const code = await drivesTrashHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(trash).not.toHaveBeenCalled();
  });
});

describe('drivesRestoreHandler', () => {
  it('calls drives.restore with driveId (not destructive: no confirmation needed)', async () => {
    const restore = vi.fn(async () => ({ success: true }));
    const prompt = vi.fn(async () => '');
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { restore } }), isTTY: true, prompt });

    const code = await drivesRestoreHandler(ctx, commandIntent(['drv_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(restore).toHaveBeenCalledWith({ driveId: 'drv_1' });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when driveId is missing', async () => {
    const restore = vi.fn(async () => ({ success: true }));
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { restore } }) });

    const code = await drivesRestoreHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(restore).not.toHaveBeenCalled();
  });
});
