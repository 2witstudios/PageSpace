import { describe, it, expect } from 'vitest';
import {
  createResolveSandboxActorContext,
  type ResolveSandboxActorContextDeps,
} from '../sandbox-tools-runtime';
import type { ToolExecutionContext } from '../../core/types';

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
