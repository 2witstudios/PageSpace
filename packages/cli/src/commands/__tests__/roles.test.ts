import { describe, expect, it, vi } from 'vitest';
import {
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  parseArgv,
  rolesCreateHandler,
  rolesDeleteHandler,
  rolesGetHandler,
  rolesListHandler,
  rolesRemovePagePermissionsHandler,
  rolesSetDriveWidePermissionsHandler,
  rolesSetPagePermissionsHandler,
  rolesUpdateHandler,
} from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(argv);
  if (intent.kind !== 'command') throw new Error('expected command');
  return intent;
}

const ROLE = {
  id: 'role_1',
  driveId: 'drv_1',
  name: 'Reviewer',
  description: null,
  color: '#ff0000',
  isDefault: false,
  permissions: {},
  driveWidePermissions: null,
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('rolesListHandler', () => {
  it('calls roles.list with driveId', async () => {
    const list = vi.fn(async () => ({ roles: [ROLE] }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { list } }) });

    const code = await rolesListHandler(ctx, commandIntent(['drv_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(list).toHaveBeenCalledWith({ driveId: 'drv_1' });
  });

  it('renders human-readable output including id and name', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ roles: { list: async () => ({ roles: [ROLE] }) } }) });

    await rolesListHandler(ctx, commandIntent(['drv_1']));

    const output = stdout.lines.join('');
    expect(output).toContain(ROLE.id);
    expect(output).toContain(ROLE.name);
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ roles: { list: async () => ({ roles: [ROLE] }) } }) });

    await rolesListHandler(ctx, commandIntent(['drv_1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual({ roles: [ROLE] });
  });

  it('exits 2 with a usage error when driveId is missing, never calling the SDK', async () => {
    const list = vi.fn(async () => ({ roles: [ROLE] }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { list } }) });

    const code = await rolesListHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(list).not.toHaveBeenCalled();
  });

  it('exits 1 and surfaces the server error on API failure', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({
      stderr,
      sdk: fakeSdk({
        roles: {
          list: async () => {
            throw new Error('permission denied');
          },
        },
      }),
    });

    const code = await rolesListHandler(ctx, commandIntent(['drv_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('permission denied');
  });
});

describe('rolesGetHandler', () => {
  it('calls roles.get with driveId and roleId', async () => {
    const get = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { get } }) });

    const code = await rolesGetHandler(ctx, commandIntent(['drv_1', 'role_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(get).toHaveBeenCalledWith({ driveId: 'drv_1', roleId: 'role_1' });
  });

  it('--json emits exactly the SDK response envelope', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ roles: { get: async () => ({ role: ROLE }) } }) });

    await rolesGetHandler(ctx, commandIntent(['drv_1', 'role_1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual({ role: ROLE });
  });

  it('exits 2 with a usage error when roleId is missing, never calling the SDK', async () => {
    const get = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { get } }) });

    const code = await rolesGetHandler(ctx, commandIntent(['drv_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('rolesCreateHandler', () => {
  it('always sends permissions: {} even when no permission flags are given', async () => {
    const create = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { create } }) });

    const code = await rolesCreateHandler(ctx, commandIntent(['drv_1', 'Reviewer']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(create).toHaveBeenCalledWith({
      driveId: 'drv_1',
      name: 'Reviewer',
      description: undefined,
      color: undefined,
      isDefault: undefined,
      permissions: {},
      driveWidePermissions: undefined,
    });
  });

  it('forwards --description, --color, and --is-default', async () => {
    const create = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { create } }) });

    await rolesCreateHandler(
      ctx,
      commandIntent(['drv_1', 'Reviewer', '--description', 'reviews things', '--color', '#00ff00', '--is-default', 'true']),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'reviews things', color: '#00ff00', isDefault: true, permissions: {} }),
    );
  });

  it('parses a full --drive-wide-view/edit/share triple', async () => {
    const create = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { create } }) });

    await rolesCreateHandler(
      ctx,
      commandIntent([
        'drv_1',
        'Reviewer',
        '--drive-wide-view',
        'true',
        '--drive-wide-edit',
        'false',
        '--drive-wide-share',
        'false',
      ]),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ driveWidePermissions: { canView: true, canEdit: false, canShare: false } }),
    );
  });

  it('exits 2 with a usage error on a partial drive-wide permission triple, never calling the SDK', async () => {
    const create = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { create } }) });

    const code = await rolesCreateHandler(ctx, commandIntent(['drv_1', 'Reviewer', '--drive-wide-view', 'true']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(create).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when name is missing, never calling the SDK', async () => {
    const create = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { create } }) });

    const code = await rolesCreateHandler(ctx, commandIntent(['drv_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('rolesUpdateHandler', () => {
  it('only forwards flags that were actually given', async () => {
    const update = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { update } }) });

    const code = await rolesUpdateHandler(ctx, commandIntent(['drv_1', 'role_1', '--name', 'New Name']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(update).toHaveBeenCalledWith({
      driveId: 'drv_1',
      roleId: 'role_1',
      name: 'New Name',
      description: undefined,
      color: undefined,
      isDefault: undefined,
      driveWidePermissions: undefined,
    });
  });

  it('--clear-drive-wide sends driveWidePermissions: null', async () => {
    const update = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { update } }) });

    await rolesUpdateHandler(ctx, commandIntent(['drv_1', 'role_1', '--clear-drive-wide']));

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ driveWidePermissions: null }));
  });

  it('exits 2 with a usage error when --clear-drive-wide and --drive-wide-* are combined', async () => {
    const update = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { update } }) });

    const code = await rolesUpdateHandler(
      ctx,
      commandIntent(['drv_1', 'role_1', '--clear-drive-wide', '--drive-wide-view', 'true', '--drive-wide-edit', 'true', '--drive-wide-share', 'true']),
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(update).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when roleId is missing, never calling the SDK', async () => {
    const update = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { update } }) });

    const code = await rolesUpdateHandler(ctx, commandIntent(['drv_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('rolesDeleteHandler (destructive)', () => {
  it('with --yes in a non-TTY session: deletes without prompting', async () => {
    const del = vi.fn(async () => ({ success: true }));
    const prompt = vi.fn(async () => 'irrelevant');
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { delete: del } }), isTTY: false, prompt });

    const code = await rolesDeleteHandler(ctx, commandIntent(['drv_1', 'role_1', '--yes']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(prompt).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith({ driveId: 'drv_1', roleId: 'role_1' });
  });

  it('fails closed in a non-TTY session without --yes, never calling delete', async () => {
    const del = vi.fn(async () => ({ success: true }));
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { delete: del } }), isTTY: false, stderr });

    const code = await rolesDeleteHandler(ctx, commandIntent(['drv_1', 'role_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(del).not.toHaveBeenCalled();
    expect(stderr.lines.join('')).toMatch(/--yes/);
  });

  it('in a TTY session without --yes, prompts and deletes on an affirmative answer', async () => {
    const del = vi.fn(async () => ({ success: true }));
    const prompt = vi.fn(async () => 'y');
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { delete: del } }), isTTY: true, prompt });

    const code = await rolesDeleteHandler(ctx, commandIntent(['drv_1', 'role_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(prompt).toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith({ driveId: 'drv_1', roleId: 'role_1' });
  });

  it('in a TTY session without --yes, refuses to delete on a declined answer', async () => {
    const del = vi.fn(async () => ({ success: true }));
    const prompt = vi.fn(async () => 'n');
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { delete: del } }), isTTY: true, prompt });

    const code = await rolesDeleteHandler(ctx, commandIntent(['drv_1', 'role_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(del).not.toHaveBeenCalled();
  });
});

describe('rolesRemovePagePermissionsHandler (destructive)', () => {
  it('with --yes in a non-TTY session: removes without prompting', async () => {
    const removePagePermissions = vi.fn(async () => ({ role: ROLE }));
    const prompt = vi.fn(async () => 'irrelevant');
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { removePagePermissions } }), isTTY: false, prompt });

    const code = await rolesRemovePagePermissionsHandler(ctx, commandIntent(['drv_1', 'role_1', 'pg_1', '--yes']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(prompt).not.toHaveBeenCalled();
    expect(removePagePermissions).toHaveBeenCalledWith({ driveId: 'drv_1', roleId: 'role_1', permissionsPatch: { pg_1: null } });
  });

  it('fails closed in a non-TTY session without --yes, never calling the SDK', async () => {
    const removePagePermissions = vi.fn(async () => ({ role: ROLE }));
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { removePagePermissions } }), isTTY: false, stderr });

    const code = await rolesRemovePagePermissionsHandler(ctx, commandIntent(['drv_1', 'role_1', 'pg_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(removePagePermissions).not.toHaveBeenCalled();
    expect(stderr.lines.join('')).toMatch(/--yes/);
  });

  it('in a TTY session without --yes, removes on an affirmative answer', async () => {
    const removePagePermissions = vi.fn(async () => ({ role: ROLE }));
    const prompt = vi.fn(async () => 'y');
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { removePagePermissions } }), isTTY: true, prompt });

    const code = await rolesRemovePagePermissionsHandler(ctx, commandIntent(['drv_1', 'role_1', 'pg_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(removePagePermissions).toHaveBeenCalledWith({ driveId: 'drv_1', roleId: 'role_1', permissionsPatch: { pg_1: null } });
  });

  it('in a TTY session without --yes, refuses on a declined answer', async () => {
    const removePagePermissions = vi.fn(async () => ({ role: ROLE }));
    const prompt = vi.fn(async () => 'n');
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { removePagePermissions } }), isTTY: true, prompt });

    const code = await rolesRemovePagePermissionsHandler(ctx, commandIntent(['drv_1', 'role_1', 'pg_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(removePagePermissions).not.toHaveBeenCalled();
  });
});

describe('rolesSetPagePermissionsHandler', () => {
  it('calls roles.setPagePermissions with the builder-shaped permissionsPatch', async () => {
    const setPagePermissions = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { setPagePermissions } }) });

    const code = await rolesSetPagePermissionsHandler(
      ctx,
      commandIntent(['drv_1', 'role_1', 'pg_1', '--view', 'true', '--edit', 'false', '--share', 'false']),
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(setPagePermissions).toHaveBeenCalledWith({
      driveId: 'drv_1',
      roleId: 'role_1',
      permissionsPatch: { pg_1: { canView: true, canEdit: false, canShare: false } },
    });
  });

  it('exits 2 with a usage error when the permission triple is missing entirely, never calling the SDK', async () => {
    const setPagePermissions = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { setPagePermissions } }) });

    const code = await rolesSetPagePermissionsHandler(ctx, commandIntent(['drv_1', 'role_1', 'pg_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(setPagePermissions).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when the permission triple is partial, never calling the SDK', async () => {
    const setPagePermissions = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { setPagePermissions } }) });

    const code = await rolesSetPagePermissionsHandler(ctx, commandIntent(['drv_1', 'role_1', 'pg_1', '--view', 'true']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(setPagePermissions).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error on an invalid (non true/false) permission value, never calling the SDK', async () => {
    const setPagePermissions = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { setPagePermissions } }) });

    const code = await rolesSetPagePermissionsHandler(
      ctx,
      commandIntent(['drv_1', 'role_1', 'pg_1', '--view', 'yes', '--edit', 'false', '--share', 'false']),
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(setPagePermissions).not.toHaveBeenCalled();
  });
});

describe('rolesSetDriveWidePermissionsHandler', () => {
  it('calls roles.setDriveWidePermissions with the builder-shaped input', async () => {
    const setDriveWidePermissions = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { setDriveWidePermissions } }) });

    const code = await rolesSetDriveWidePermissionsHandler(
      ctx,
      commandIntent(['drv_1', 'role_1', '--view', 'true', '--edit', 'true', '--share', 'false']),
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(setDriveWidePermissions).toHaveBeenCalledWith({
      driveId: 'drv_1',
      roleId: 'role_1',
      driveWidePermissions: { canView: true, canEdit: true, canShare: false },
    });
  });

  it('exits 2 with a usage error when the permission triple is missing, never calling the SDK', async () => {
    const setDriveWidePermissions = vi.fn(async () => ({ role: ROLE }));
    const ctx = createFakeContext({ sdk: fakeSdk({ roles: { setDriveWidePermissions } }) });

    const code = await rolesSetDriveWidePermissionsHandler(ctx, commandIntent(['drv_1', 'role_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(setDriveWidePermissions).not.toHaveBeenCalled();
  });
});
