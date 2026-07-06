/**
 * Unit tests for global-terminal-config-repository.
 *
 * DB access is delegated to already-tested primitives (config-repository,
 * drive-service, page-repository); these tests mock those primitives and
 * verify this module's own logic — jsonb coercion, Home-drive-scoped
 * validation, and own-machine-page lazy provisioning/reuse.
 */

import { describe, it, expect, vi } from 'vitest';

const { mockGetOrCreateConfig, mockUpdateRawConfig, mockGetHomeDrive, mockGetUserAccessiblePagesInDrive, mockDbSelect, mockPageRepoFindById, mockPageRepoGetNextPosition, mockPageRepoCreate, mockProvisionHomeDriveIfNeeded } =
  vi.hoisted(() => ({
    mockGetOrCreateConfig: vi.fn(),
    mockUpdateRawConfig: vi.fn(),
    mockGetHomeDrive: vi.fn(),
    mockGetUserAccessiblePagesInDrive: vi.fn(),
    mockDbSelect: vi.fn(),
    mockPageRepoFindById: vi.fn(),
    mockPageRepoGetNextPosition: vi.fn(),
    mockPageRepoCreate: vi.fn(),
    mockProvisionHomeDriveIfNeeded: vi.fn(),
  }));

vi.mock('@pagespace/db/db', () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', title: 'title', type: 'type', isTrashed: 'isTrashed' },
}));
vi.mock('@pagespace/lib/integrations/repositories/config-repository', () => ({
  getOrCreateConfig: (...args: unknown[]) => mockGetOrCreateConfig(...args),
  updateConfig: (...args: unknown[]) => mockUpdateRawConfig(...args),
}));
vi.mock('@pagespace/lib/services/drive-service', () => ({
  getHomeDrive: (...args: unknown[]) => mockGetHomeDrive(...args),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserAccessiblePagesInDrive: (...args: unknown[]) => mockGetUserAccessiblePagesInDrive(...args),
}));
vi.mock('@pagespace/lib/repositories/page-repository', () => ({
  pageRepository: {
    findById: (...args: unknown[]) => mockPageRepoFindById(...args),
    getNextPosition: (...args: unknown[]) => mockPageRepoGetNextPosition(...args),
    create: (...args: unknown[]) => mockPageRepoCreate(...args),
  },
}));
vi.mock('@pagespace/lib/content/page-types.config', () => ({
  getDefaultContent: () => '',
}));
vi.mock('@/lib/onboarding/home-drive', () => ({
  provisionHomeDriveIfNeeded: (...args: unknown[]) => mockProvisionHomeDriveIfNeeded(...args),
}));

import { globalTerminalConfigRepository } from '../global-terminal-config-repository';

describe('globalTerminalConfigRepository.getConfig', () => {
  it('given machines is not a valid MachineRef array (e.g. null), should coerce to an empty array', async () => {
    mockGetOrCreateConfig.mockResolvedValue({ terminalAccess: false, machines: null });
    const result = await globalTerminalConfigRepository.getConfig('u1');
    expect(result).toEqual({ terminalAccess: false, machines: [] });
  });

  it('given a valid MachineRef array, should pass it through', async () => {
    mockGetOrCreateConfig.mockResolvedValue({
      terminalAccess: true,
      machines: [{ kind: 'own' }, { kind: 'existing', terminalId: 't1' }],
    });
    const result = await globalTerminalConfigRepository.getConfig('u1');
    expect(result).toEqual({
      terminalAccess: true,
      machines: [{ kind: 'own' }, { kind: 'existing', terminalId: 't1' }],
    });
  });
});

describe('globalTerminalConfigRepository.updateConfig', () => {
  it('should forward only the defined fields to the raw config update', async () => {
    mockUpdateRawConfig.mockResolvedValue({ terminalAccess: true, machines: [{ kind: 'own' }] });
    await globalTerminalConfigRepository.updateConfig('u1', { terminalAccess: true });
    expect(mockUpdateRawConfig).toHaveBeenCalledWith(expect.anything(), 'u1', { terminalAccess: true });
  });
});

describe('globalTerminalConfigRepository.validateMachines', () => {
  it('given no "existing" machines, should short-circuit ok without a DB lookup', async () => {
    const result = await globalTerminalConfigRepository.validateMachines('u1', [{ kind: 'own' }]);
    expect(result).toEqual({ ok: true });
    expect(mockGetHomeDrive).not.toHaveBeenCalled();
  });

  it('given the user has no Home drive yet, should reject every existing terminalId as invalid', async () => {
    mockGetHomeDrive.mockResolvedValue(null);
    const result = await globalTerminalConfigRepository.validateMachines('u1', [
      { kind: 'existing', terminalId: 't1' },
    ]);
    expect(result).toEqual({ ok: false, invalidIds: ['t1'] });
  });

  it('given a terminalId outside the accessible set, should report it as invalid', async () => {
    mockGetHomeDrive.mockResolvedValue({ id: 'home-1' });
    mockGetUserAccessiblePagesInDrive.mockResolvedValue(['t1']);
    mockDbSelect.mockReturnValue({
      from: () => ({
        where: async () => [{ id: 't1' }],
      }),
    });
    const result = await globalTerminalConfigRepository.validateMachines('u1', [
      { kind: 'existing', terminalId: 't1' },
      { kind: 'existing', terminalId: 't2' },
    ]);
    expect(result).toEqual({ ok: false, invalidIds: ['t2'] });
  });

  it('given every terminalId resolves and is accessible, should return ok', async () => {
    mockGetHomeDrive.mockResolvedValue({ id: 'home-1' });
    mockGetUserAccessiblePagesInDrive.mockResolvedValue(['t1']);
    mockDbSelect.mockReturnValue({
      from: () => ({
        where: async () => [{ id: 't1' }],
      }),
    });
    const result = await globalTerminalConfigRepository.validateMachines('u1', [
      { kind: 'existing', terminalId: 't1' },
    ]);
    expect(result).toEqual({ ok: true });
  });
});

describe('globalTerminalConfigRepository.getOrCreateOwnMachinePageId', () => {
  it('given an existing valid ownMachinePageId, should reuse it without creating a new page', async () => {
    mockGetOrCreateConfig.mockResolvedValue({ ownMachinePageId: 'page-1' });
    mockPageRepoFindById.mockResolvedValue({ id: 'page-1', type: 'TERMINAL' });

    const result = await globalTerminalConfigRepository.getOrCreateOwnMachinePageId('u1');

    expect(result).toBe('page-1');
    expect(mockProvisionHomeDriveIfNeeded).not.toHaveBeenCalled();
  });

  it('given no ownMachinePageId yet, should provision the Home drive and create a personal Terminal page', async () => {
    mockGetOrCreateConfig.mockResolvedValue({ ownMachinePageId: null });
    mockProvisionHomeDriveIfNeeded.mockResolvedValue({ driveId: 'home-drive-1', created: false });
    mockPageRepoGetNextPosition.mockResolvedValue(1);
    mockPageRepoCreate.mockResolvedValue({ id: 'new-page-1', title: 'My Machine', type: 'TERMINAL' });

    const result = await globalTerminalConfigRepository.getOrCreateOwnMachinePageId('u1');

    expect(result).toBe('new-page-1');
    expect(mockPageRepoCreate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TERMINAL', driveId: 'home-drive-1', createdBy: 'u1' }),
    );
    expect(mockUpdateRawConfig).toHaveBeenCalledWith(expect.anything(), 'u1', { ownMachinePageId: 'new-page-1' });
  });

  it('given a stale ownMachinePageId whose page no longer exists, should re-provision a new one', async () => {
    mockGetOrCreateConfig.mockResolvedValue({ ownMachinePageId: 'deleted-page' });
    mockPageRepoFindById.mockResolvedValue(null);
    mockProvisionHomeDriveIfNeeded.mockResolvedValue({ driveId: 'home-drive-1', created: false });
    mockPageRepoGetNextPosition.mockResolvedValue(2);
    mockPageRepoCreate.mockResolvedValue({ id: 'replacement-page', title: 'My Machine', type: 'TERMINAL' });

    const result = await globalTerminalConfigRepository.getOrCreateOwnMachinePageId('u1');

    expect(result).toBe('replacement-page');
  });
});
