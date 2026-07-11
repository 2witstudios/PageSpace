import { describe, it, expect } from 'vitest';
import {
  createResolveSandboxActorContext,
  createMachineDirectory,
  type ResolveSandboxActorContextDeps,
  type MachineDirectoryRuntimeDeps,
} from '../sandbox-tools-runtime';
import type { ToolExecutionContext } from '../../core/types';
import type { MachineRef } from '@/lib/repositories/page-agent-repository';

function makeDeps(overrides: Partial<ResolveSandboxActorContextDeps> = {}): ResolveSandboxActorContextDeps {
  return {
    findDrive: async () => ({ ownerId: 'tenant-1' }),
    findPageDriveId: async () => undefined,
    findUser: async () => ({ subscriptionTier: 'pro' }),
    getActorInfo: async () => ({ actorEmail: 'u1@example.com', actorDisplayName: 'User One' }),
    ...overrides,
  };
}

const baseGlobalContext: ToolExecutionContext = {
  userId: 'u1',
  conversationId: 'conv-1',
  chatSource: { type: 'global' },
};

const basePageContext: ToolExecutionContext = {
  userId: 'u1',
  conversationId: 'conv-1',
  chatSource: { type: 'page', agentPageId: 'page-agent-1' },
};

describe('resolveSandboxActorContext', () => {
  describe('given no context (unauthenticated)', () => {
    it('should return an authentication error', async () => {
      const resolve = createResolveSandboxActorContext(makeDeps());
      const result = await resolve(undefined);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toContain('Code execution requires an authenticated user.');
    });
  });

  describe('given userId present but no conversationId', () => {
    it('should return a conversation error', async () => {
      const context: ToolExecutionContext = { userId: 'u1', chatSource: { type: 'global' } };
      const resolve = createResolveSandboxActorContext(makeDeps());
      const result = await resolve(context);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toContain('Code execution requires a conversation.');
    });
  });

  describe('given chatSource type "page" and currentDrive present', () => {
    it('should resolve with driveId and tenantId from drive ownerId', async () => {
      const context: ToolExecutionContext = {
        ...basePageContext,
        locationContext: { currentDrive: { id: 'd1', name: 'Drive 1', slug: 'drive-1' } },
      };
      const resolve = createResolveSandboxActorContext(
        makeDeps({ findDrive: async () => ({ ownerId: 'owner-1' }) }),
      );
      const result = await resolve(context);
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.driveId).toBe('d1');
      expect(result.tenantId).toBe('owner-1');
    });
  });

  describe('given chatSource type "global", currentDrive present, but drive not found in DB', () => {
    it('should return an active drive error', async () => {
      const context: ToolExecutionContext = {
        ...baseGlobalContext,
        locationContext: { currentDrive: { id: 'd-missing', name: 'X', slug: 'x' } },
      };
      const resolve = createResolveSandboxActorContext(
        makeDeps({ findDrive: async () => undefined }),
      );
      const result = await resolve(context);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toContain('Code execution requires an active drive.');
    });
  });

  describe('given chatSource type "global" and no currentDrive', () => {
    it('should resolve successfully with driveId undefined and tenantId equal to userId', async () => {
      const resolve = createResolveSandboxActorContext(makeDeps());
      const result = await resolve(baseGlobalContext);
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.userId).toBe('u1');
      expect(result.tenantId).toBe('u1');
      expect(result.driveId).toBeUndefined();
      expect(result.conversationId).toBe('conv-1');
      expect(result.actorEmail).toBe('u1@example.com');
    });
  });

  describe('given chatSource type "page" and no currentDrive', () => {
    it('should return error containing "Code execution requires an active drive."', async () => {
      const resolve = createResolveSandboxActorContext(makeDeps());
      const result = await resolve(basePageContext);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toContain('Code execution requires an active drive.');
    });
  });

  describe('given chatSource type "page", no currentDrive, and agent page has a drive', () => {
    it('should resolve driveId from the agent page before applying the drive tenant lookup', async () => {
      const seenDriveIds: string[] = [];
      const resolve = createResolveSandboxActorContext(
        makeDeps({
          findPageDriveId: async (pageId) => pageId === 'page-agent-1' ? 'drive-from-page' : undefined,
          findDrive: async (driveId) => {
            seenDriveIds.push(driveId);
            return { ownerId: 'tenant-from-page-drive' };
          },
        }),
      );

      const result = await resolve(basePageContext);

      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.driveId).toBe('drive-from-page');
      expect(result.tenantId).toBe('tenant-from-page-drive');
      expect(seenDriveIds).toEqual(['drive-from-page']);
    });
  });

  describe('given chatSource type "global" and currentDrive present', () => {
    it('should resolve with driveId from locationContext and tenantId from drive ownerId', async () => {
      const context: ToolExecutionContext = {
        ...baseGlobalContext,
        locationContext: {
          currentDrive: { id: 'd1', name: 'My Drive', slug: 'my-drive' },
        },
      };
      const resolve = createResolveSandboxActorContext(
        makeDeps({ findDrive: async () => ({ ownerId: 'tenant-from-drive' }) }),
      );
      const result = await resolve(context);
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.driveId).toBe('d1');
      expect(result.tenantId).toBe('tenant-from-drive');
    });
  });
});

function makeMachineDirectoryDeps(
  overrides: Partial<MachineDirectoryRuntimeDeps> = {},
): MachineDirectoryRuntimeDeps {
  return {
    findPage: async () => ({ title: 'Shared Terminal', type: 'MACHINE', driveId: 'drive-1' }),
    canViewPage: async () => true,
    getAgentConfig: async () => ({ machineAccess: false, machines: [] }),
    getGlobalConfig: async () => ({ machineAccess: false, machines: [] }),
    getOrCreateOwnMachinePageId: async () => 'own-machine-page-1',
    lookupPageOwnerId: async () => 'drive-owner-1',
    ...overrides,
  };
}

const pageContext: ToolExecutionContext = {
  userId: 'u1',
  chatSource: { type: 'page', agentPageId: 'agent-1' },
};

describe('createMachineDirectory', () => {
  describe('listMachines', () => {
    it('given no rawContext at all, should return no machines (no userId to resolve a global config for)', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps());
      await expect(directory.listMachines(undefined)).resolves.toEqual([]);
    });

    it('given a global assistant context with machineAccess off, should return no machines (fail closed)', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ getGlobalConfig: async () => ({ machineAccess: false, machines: [] }) }),
      );
      await expect(directory.listMachines({ userId: 'u1', chatSource: { type: 'global' } })).resolves.toEqual([]);
    });

    it('given a global assistant context with machineAccess on and no machines configured, should default to the own machine resolved into the personal Terminal page', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({
          getGlobalConfig: async () => ({ machineAccess: true, machines: [] }),
          getOrCreateOwnMachinePageId: async () => 'personal-page-1',
        }),
      );
      await expect(directory.listMachines({ userId: 'u1', chatSource: { type: 'global' } })).resolves.toEqual([
        { kind: 'existing', machineId: 'personal-page-1' },
      ]);
    });

    it('given a global assistant context with configured machines including "own", should resolve only "own" into the personal Terminal page and pass "existing" machines through', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({
          getGlobalConfig: async () => ({
            machineAccess: true,
            machines: [{ kind: 'own' }, { kind: 'existing', machineId: 't1' }],
          }),
          getOrCreateOwnMachinePageId: async () => 'personal-page-1',
        }),
      );
      await expect(directory.listMachines({ userId: 'u1', chatSource: { type: 'global' } })).resolves.toEqual([
        { kind: 'existing', machineId: 'personal-page-1' },
        { kind: 'existing', machineId: 't1' },
      ]);
    });

    it('given a page agent with machineAccess off, should return no machines (fail closed)', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ getAgentConfig: async () => ({ machineAccess: false, machines: [{ kind: 'own' }] }) }),
      );
      await expect(directory.listMachines(pageContext)).resolves.toEqual([]);
    });

    it('given a page agent with machineAccess on and configured machines, should return the configured machines', async () => {
      const machines: MachineRef[] = [{ kind: 'own' }, { kind: 'existing', machineId: 't1' }];
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ getAgentConfig: async () => ({ machineAccess: true, machines }) }),
      );
      await expect(directory.listMachines(pageContext)).resolves.toEqual(machines);
    });

    it('given a page agent with machineAccess on but no machines configured, should default to the own machine', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ getAgentConfig: async () => ({ machineAccess: true, machines: [] }) }),
      );
      await expect(directory.listMachines(pageContext)).resolves.toEqual([{ kind: 'own' }]);
    });

    it('given no agent config found for the page, should return no machines (fail closed)', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ getAgentConfig: async () => null }));
      await expect(directory.listMachines(pageContext)).resolves.toEqual([]);
    });

    it('given a sub-agent context (parentAgentId, no chatSource), should resolve config for the parent agent', async () => {
      const seen: string[] = [];
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({
          getAgentConfig: async (agentPageId) => {
            seen.push(agentPageId);
            return { machineAccess: true, machines: [{ kind: 'own' }] };
          },
        }),
      );
      await directory.listMachines({ userId: 'u1', parentAgentId: 'parent-agent-1' });
      expect(seen).toEqual(['parent-agent-1']);
    });
  });

  describe('describeMachine', () => {
    it('given the own machine, should return a fixed name without a DB lookup', async () => {
      const findPage = async () => ({ title: 'should not be used', type: 'MACHINE', driveId: 'drive-1' });
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ findPage }));
      await expect(directory.describeMachine(undefined, { kind: 'own' })).resolves.toEqual({ name: 'My Machine' });
    });

    it('given an existing machine, should return the Terminal page title', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ findPage: async () => ({ title: 'Shared Terminal', type: 'MACHINE', driveId: 'drive-1' }) }),
      );
      await expect(
        directory.describeMachine(undefined, { kind: 'existing', machineId: 't1' }),
      ).resolves.toEqual({ name: 'Shared Terminal' });
    });

    it('given an existing machine whose page is missing, should fall back to a generic name', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ findPage: async () => undefined }));
      await expect(
        directory.describeMachine(undefined, { kind: 'existing', machineId: 'gone' }),
      ).resolves.toEqual({ name: 'Terminal' });
    });
  });

  describe('isMachineAccessible', () => {
    const context: ToolExecutionContext = { userId: 'u1' };

    it('given the own machine, should always be accessible', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps());
      await expect(directory.isMachineAccessible(undefined, { kind: 'own' })).resolves.toBe(true);
    });

    it('given no rawContext, should deny an existing machine (fail closed)', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps());
      await expect(
        directory.isMachineAccessible(undefined, { kind: 'existing', machineId: 't1' }),
      ).resolves.toBe(false);
    });

    it('given the terminal page is missing, should deny', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ findPage: async () => undefined }));
      await expect(
        directory.isMachineAccessible(context, { kind: 'existing', machineId: 'gone' }),
      ).resolves.toBe(false);
    });

    it('given the page exists but is not a MACHINE page, should deny', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ findPage: async () => ({ title: 'Not a terminal', type: 'DOCUMENT', driveId: 'drive-1' }) }),
      );
      await expect(
        directory.isMachineAccessible(context, { kind: 'existing', machineId: 'doc-1' }),
      ).resolves.toBe(false);
    });

    it('given a MACHINE page the actor cannot view, should deny', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ canViewPage: async () => false }));
      await expect(
        directory.isMachineAccessible(context, { kind: 'existing', machineId: 't1' }),
      ).resolves.toBe(false);
    });

    it('given a MACHINE page the actor can view, should allow', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ canViewPage: async () => true }));
      await expect(
        directory.isMachineAccessible(context, { kind: 'existing', machineId: 't1' }),
      ).resolves.toBe(true);
    });
  });

  describe('resolveDriveId', () => {
    it('given the own machine, should return the ambient driveId unchanged (page-agent path)', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps());
      await expect(
        directory.resolveDriveId?.(undefined, { kind: 'own' }, 'ambient-drive'),
      ).resolves.toBe('ambient-drive');
    });

    it('given an existing machine, should return the Terminal page\'s own driveId, overriding the ambient one', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({
          findPage: async () => ({ title: 'Personal Machine', type: 'MACHINE', driveId: 'home-drive-1' }),
        }),
      );
      await expect(
        directory.resolveDriveId?.(undefined, { kind: 'existing', machineId: 't1' }, 'ambient-drive'),
      ).resolves.toBe('home-drive-1');
    });

    it('given an existing machine whose page has vanished, should fall back to the ambient driveId', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ findPage: async () => undefined }));
      await expect(
        directory.resolveDriveId?.(undefined, { kind: 'existing', machineId: 'gone' }, 'ambient-drive'),
      ).resolves.toBe('ambient-drive');
    });
  });

  describe('resolveTenantId', () => {
    it('given the own machine, should return the ambient tenantId unchanged (page-agent path)', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps());
      await expect(
        directory.resolveTenantId?.(undefined, { kind: 'own' }, 'ambient-tenant'),
      ).resolves.toBe('ambient-tenant');
    });

    it('given an existing machine in a different drive, should return that drive\'s ownerId, overriding the ambient tenantId', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ lookupPageOwnerId: async () => 'real-drive-owner' }),
      );
      await expect(
        directory.resolveTenantId?.(undefined, { kind: 'existing', machineId: 't1' }, 'ambient-tenant'),
      ).resolves.toBe('real-drive-owner');
    });

    it('given an existing machine whose page/drive can\'t be resolved, should fall back to the ambient tenantId', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ lookupPageOwnerId: async () => null }),
      );
      await expect(
        directory.resolveTenantId?.(undefined, { kind: 'existing', machineId: 'gone' }, 'ambient-tenant'),
      ).resolves.toBe('ambient-tenant');
    });
  });
});
