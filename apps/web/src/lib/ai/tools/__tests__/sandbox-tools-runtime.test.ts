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
    findPage: async () => ({ title: 'Shared Terminal', type: 'TERMINAL' }),
    canViewPage: async () => true,
    getAgentConfig: async () => ({ terminalAccess: false, machines: [] }),
    ...overrides,
  };
}

const pageContext: ToolExecutionContext = {
  userId: 'u1',
  chatSource: { type: 'page', agentPageId: 'agent-1' },
};

describe('createMachineDirectory', () => {
  describe('listMachines', () => {
    it('given no agentPageId (global assistant, no per-page config surface yet), should return a fixed own machine', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps());
      await expect(directory.listMachines(undefined)).resolves.toEqual([{ kind: 'own' }]);
      await expect(directory.listMachines({ userId: 'u1', chatSource: { type: 'global' } })).resolves.toEqual([
        { kind: 'own' },
      ]);
    });

    it('given a page agent with terminalAccess off, should return no machines (fail closed)', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ getAgentConfig: async () => ({ terminalAccess: false, machines: [{ kind: 'own' }] }) }),
      );
      await expect(directory.listMachines(pageContext)).resolves.toEqual([]);
    });

    it('given a page agent with terminalAccess on and configured machines, should return the configured machines', async () => {
      const machines: MachineRef[] = [{ kind: 'own' }, { kind: 'existing', terminalId: 't1' }];
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ getAgentConfig: async () => ({ terminalAccess: true, machines }) }),
      );
      await expect(directory.listMachines(pageContext)).resolves.toEqual(machines);
    });

    it('given a page agent with terminalAccess on but no machines configured, should default to the own machine', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ getAgentConfig: async () => ({ terminalAccess: true, machines: [] }) }),
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
            return { terminalAccess: true, machines: [{ kind: 'own' }] };
          },
        }),
      );
      await directory.listMachines({ userId: 'u1', parentAgentId: 'parent-agent-1' });
      expect(seen).toEqual(['parent-agent-1']);
    });
  });

  describe('describeMachine', () => {
    it('given the own machine, should return a fixed name without a DB lookup', async () => {
      const findPage = async () => ({ title: 'should not be used', type: 'TERMINAL' });
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ findPage }));
      await expect(directory.describeMachine(undefined, { kind: 'own' })).resolves.toEqual({ name: 'My Machine' });
    });

    it('given an existing machine, should return the Terminal page title', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ findPage: async () => ({ title: 'Shared Terminal', type: 'TERMINAL' }) }),
      );
      await expect(
        directory.describeMachine(undefined, { kind: 'existing', terminalId: 't1' }),
      ).resolves.toEqual({ name: 'Shared Terminal' });
    });

    it('given an existing machine whose page is missing, should fall back to a generic name', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ findPage: async () => undefined }));
      await expect(
        directory.describeMachine(undefined, { kind: 'existing', terminalId: 'gone' }),
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
        directory.isMachineAccessible(undefined, { kind: 'existing', terminalId: 't1' }),
      ).resolves.toBe(false);
    });

    it('given the terminal page is missing, should deny', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ findPage: async () => undefined }));
      await expect(
        directory.isMachineAccessible(context, { kind: 'existing', terminalId: 'gone' }),
      ).resolves.toBe(false);
    });

    it('given the page exists but is not a TERMINAL page, should deny', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ findPage: async () => ({ title: 'Not a terminal', type: 'DOCUMENT' }) }),
      );
      await expect(
        directory.isMachineAccessible(context, { kind: 'existing', terminalId: 'doc-1' }),
      ).resolves.toBe(false);
    });

    it('given a TERMINAL page the actor cannot view, should deny', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ canViewPage: async () => false }));
      await expect(
        directory.isMachineAccessible(context, { kind: 'existing', terminalId: 't1' }),
      ).resolves.toBe(false);
    });

    it('given a TERMINAL page the actor can view, should allow', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ canViewPage: async () => true }));
      await expect(
        directory.isMachineAccessible(context, { kind: 'existing', terminalId: 't1' }),
      ).resolves.toBe(true);
    });
  });
});
