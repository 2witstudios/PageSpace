import { describe, it, expect, vi, beforeEach } from 'vitest';

// Only the IO seams the REAL canActorViewPage touches are faked (the
// acting-page row lookup, the user ACL, the agent ACL), so the machine-pane pin
// at the bottom of this file runs the actual actor-permissions chain end-to-end
// instead of a stubbed predicate. Every other describe here injects its own
// `canViewPage` through makeMachineDirectoryDeps and never reaches these.
const { mockDbWhere, mockGetUserAccessLevel, mockGetAgentAccessLevel } = vi.hoisted(() => ({
  mockDbWhere: vi.fn(),
  mockGetUserAccessLevel: vi.fn(),
  // A MACHINE page has no driveAgentMembers row — the agent path can only ever
  // return null for it, which is exactly how the field bug denied every tool.
  mockGetAgentAccessLevel: vi.fn().mockResolvedValue(null),
}));
vi.mock('@pagespace/db/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: { select: () => ({ from: () => ({ where: mockDbWhere }) }) },
}));
vi.mock('@pagespace/lib/permissions/permissions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUserAccessLevel: mockGetUserAccessLevel,
}));
vi.mock('@pagespace/lib/permissions/agent-permissions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentAccessLevel: mockGetAgentAccessLevel,
}));

import {
  createResolveSandboxActorContext,
  createMachineDirectory,
  type ResolveSandboxActorContextDeps,
  type MachineDirectoryRuntimeDeps,
} from '../sandbox-tools-runtime';
import { canActorViewPage } from '../actor-permissions';
import type { ToolExecutionContext } from '../../core/types';
import type { MachineRef } from '@/lib/repositories/page-agent-repository';
import type { MachineNodeHandle, MachineNodeHandleSet } from '@pagespace/lib/services/machines/machine-pane-binding';

/**
 * A machine-bound pane's handle set, as `deriveMachinePaneBinding` produces it.
 * `handles` defaults to `[self]` — the leaf case — because these suites assert
 * self-node behaviour; the cascade set itself is covered by the pure core's own
 * suite (packages/lib machines/__tests__/machine-pane-binding.test.ts).
 */
function boundTo(
  machineId: string,
  cwd: string,
  branchSandbox?: { machineBranchId: string; sandboxId: string },
): MachineNodeHandleSet {
  const self: MachineNodeHandle = {
    kind: branchSandbox ? 'branch' : 'machine',
    machineId,
    cwd,
    ...(branchSandbox ? { branchSandbox } : {}),
  };
  return { self, handles: [self] };
}

/** A handle set built handle-by-handle: `self` first, then its downward closure. */
function setOf(self: MachineNodeHandle, ...descendants: MachineNodeHandle[]): MachineNodeHandleSet {
  return { self, handles: [self, ...descendants] };
}


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

  describe('turnId stamping (Sprites Platform Alignment 5-2)', () => {
    // Deliberately fresh, standalone context objects per test (not the shared
    // module-level `baseGlobalContext`, which sibling tests above mutate
    // in-place via stamping — reusing it here would leak a turnId across
    // tests and defeat the very thing being asserted).
    function freshGlobalContext(): ToolExecutionContext {
      return { userId: 'u1', conversationId: 'conv-1', chatSource: { type: 'global' } };
    }

    it('stamps a turnId onto the resolved ctx when the raw context has none yet', async () => {
      const resolve = createResolveSandboxActorContext(makeDeps());
      const result = await resolve(freshGlobalContext());
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.turnId).toBeTruthy();
    });

    it('reuses the SAME turnId across multiple tool calls sharing one context object (one streamText run)', async () => {
      const resolve = createResolveSandboxActorContext(makeDeps());
      const sharedContext = freshGlobalContext();

      const first = await resolve(sharedContext);
      const second = await resolve(sharedContext);

      expect('error' in first).toBe(false);
      expect('error' in second).toBe(false);
      if ('error' in first || 'error' in second) return;
      expect(first.turnId).toBe(second.turnId);
      // The stamp is visible on the raw context too — later non-sandbox code
      // paths reading it (or a second resolve call) see the same value.
      expect(sharedContext.turnId).toBe(first.turnId);
    });

    it('mints a DIFFERENT turnId for a different context object (a new streamText run)', async () => {
      const resolve = createResolveSandboxActorContext(makeDeps());
      const first = await resolve(freshGlobalContext());
      const second = await resolve(freshGlobalContext());
      expect('error' in first).toBe(false);
      expect('error' in second).toBe(false);
      if ('error' in first || 'error' in second) return;
      expect(first.turnId).not.toBe(second.turnId);
    });
  });
});

function makeMachineDirectoryDeps(
  overrides: Partial<MachineDirectoryRuntimeDeps> = {},
): MachineDirectoryRuntimeDeps {
  return {
    findPage: async () => ({
      title: 'Shared Terminal',
      type: 'MACHINE',
      driveId: 'drive-1',
      isTrashed: false,
      allowPageAgents: true,
      visibleToGlobalAssistant: true,
    }),
    canViewPage: async () => true,
    getAgentConfig: async () => ({ machineAccess: false, machines: [] }),
    getGlobalConfig: async () => ({ machineAccess: false, machines: [] }),
    getOrCreateOwnMachinePageId: async () => 'own-machine-page-1',
    lookupPageOwnerId: async () => 'drive-owner-1',
    isUserScopedAgent: async () => false,
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

    it('given a global assistant context, should NOT filter hidden machines at resolution — isMachineAccessible is the single policy site (it denies them with the toggle reason)', async () => {
      const machines: MachineRef[] = [
        { kind: 'existing', machineId: 'hidden-1' },
        { kind: 'existing', machineId: 'visible-1' },
      ];
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({
          getGlobalConfig: async () => ({ machineAccess: true, machines }),
          findPage: async (pageId) => ({
            title: pageId === 'hidden-1' ? 'Hidden Machine' : 'Visible Machine',
            type: 'MACHINE',
            driveId: 'drive-1',
            isTrashed: false,
            allowPageAgents: true,
            visibleToGlobalAssistant: pageId !== 'hidden-1',
          }),
        }),
      );
      await expect(directory.listMachines({ userId: 'u1', chatSource: { type: 'global' } })).resolves.toEqual(
        machines,
      );
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

    describe('machine-bound "PageSpace Agent" panes (machineBinding)', () => {
      it('given a machineBinding, should collapse to exactly the bound machine — ignoring the agent\'s own configured machine list entirely', async () => {
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({
            getAgentConfig: async () => ({
              machineAccess: true,
              machines: [{ kind: 'own' }, { kind: 'existing', machineId: 'other-1' }],
            }),
          }),
        );
        const context: ToolExecutionContext = {
          userId: 'u1',
          chatSource: { type: 'page', agentPageId: 'agent-1' },
          machineBinding: boundTo('bound-1', '/workspace'),
        };
        await expect(directory.listMachines(context)).resolves.toEqual([
          { kind: 'existing', machineId: 'bound-1' },
        ]);
      });

      it('given a machineBinding on the global assistant context, should still collapse to the bound machine (not resolve the global config at all)', async () => {
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({
            getGlobalConfig: async () => ({ machineAccess: false, machines: [] }),
          }),
        );
        const context: ToolExecutionContext = {
          userId: 'u1',
          chatSource: { type: 'global' },
          machineBinding: boundTo('bound-1', '/workspace'),
        };
        await expect(directory.listMachines(context)).resolves.toEqual([
          { kind: 'existing', machineId: 'bound-1' },
        ]);
      });

      // The short-circuit's source of truth is the DERIVED SET, not `self`
      // alone. Today's derivation only ever produces handles on one machine,
      // so this fixture is synthetic — it exists to pin WHERE the answer comes
      // from, so lazy project-Sprite promotion (phase 7) cannot quietly gain a
      // machine the list never reports.
      it('given a bound conversation, should return the machines of the whole derived set, deduped', async () => {
        const directory = createMachineDirectory(makeMachineDirectoryDeps());
        const context: ToolExecutionContext = {
          userId: 'u1',
          chatSource: { type: 'page', agentPageId: 'agent-1' },
          machineBinding: setOf(
            { kind: 'machine', machineId: 'bound-1', cwd: '/workspace' },
            { kind: 'project', machineId: 'bound-1', project: 'repo', cwd: '/workspace/repo' },
            { kind: 'project', machineId: 'bound-2', project: 'elsewhere', cwd: '/workspace/elsewhere' },
          ),
        };
        await expect(directory.listMachines(context)).resolves.toEqual([
          { kind: 'existing', machineId: 'bound-1' },
          { kind: 'existing', machineId: 'bound-2' },
        ]);
      });
    });
  });

  describe('describeMachine', () => {
    it('given the own machine, should return a fixed name without a DB lookup', async () => {
      const findPage = async () => ({ title: 'should not be used', type: 'MACHINE', driveId: 'drive-1', isTrashed: false, allowPageAgents: true, visibleToGlobalAssistant: true });
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ findPage }));
      await expect(directory.describeMachine(undefined, { kind: 'own' })).resolves.toEqual({ name: 'My Machine' });
    });

    it('given an existing machine, should return the Terminal page title', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ findPage: async () => ({ title: 'Shared Terminal', type: 'MACHINE', driveId: 'drive-1', isTrashed: false, allowPageAgents: true, visibleToGlobalAssistant: true }) }),
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
    const globalContext: ToolExecutionContext = { userId: 'u1', chatSource: { type: 'global' } };

    it('given the own machine, should always be accessible', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps());
      await expect(directory.isMachineAccessible(undefined, { kind: 'own' })).resolves.toEqual({ allowed: true });
    });

    it('given no rawContext, should deny an existing machine (fail closed)', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps());
      await expect(
        directory.isMachineAccessible(undefined, { kind: 'existing', machineId: 't1' }),
      ).resolves.toEqual({ allowed: false });
    });

    it('given the terminal page is missing, should deny', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ findPage: async () => undefined }));
      await expect(
        directory.isMachineAccessible(context, { kind: 'existing', machineId: 'gone' }),
      ).resolves.toEqual({ allowed: false });
    });

    it('given the page exists but is not a MACHINE page, should deny', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({ findPage: async () => ({ title: 'Not a terminal', type: 'DOCUMENT', driveId: 'drive-1', isTrashed: false, allowPageAgents: true, visibleToGlobalAssistant: true }) }),
      );
      await expect(
        directory.isMachineAccessible(context, { kind: 'existing', machineId: 'doc-1' }),
      ).resolves.toEqual({ allowed: false });
    });

    it('given a MACHINE page the actor cannot view, should deny', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ canViewPage: async () => false }));
      await expect(
        directory.isMachineAccessible(context, { kind: 'existing', machineId: 't1' }),
      ).resolves.toEqual({ allowed: false });
    });

    it('given a MACHINE page the actor can view, should allow', async () => {
      const directory = createMachineDirectory(makeMachineDirectoryDeps({ canViewPage: async () => true }));
      await expect(
        directory.isMachineAccessible(context, { kind: 'existing', machineId: 't1' }),
      ).resolves.toEqual({ allowed: true });
    });

    it('given a TRASHED machine page, should deny (a soft-deleted machine must not accept agent commands)', async () => {
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({
          findPage: async () => ({
            title: 'Trashed Machine',
            type: 'MACHINE',
            driveId: 'drive-1',
            isTrashed: true,
            allowPageAgents: true,
            visibleToGlobalAssistant: true,
          }),
        }),
      );
      await expect(
        directory.isMachineAccessible(context, { kind: 'existing', machineId: 't1' }),
      ).resolves.toEqual({ allowed: false });
    });

    describe('allowPageAgents toggle (Machine Settings)', () => {
      const machineDenyingPageAgents = async () => ({
        title: 'Locked Machine',
        type: 'MACHINE',
        driveId: 'drive-1',
        isTrashed: false,
        allowPageAgents: false,
        visibleToGlobalAssistant: true,
      });

      it('given a page-scoped agent and allowPageAgents=false, should deny with the toggle code and an LLM-facing reason', async () => {
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ findPage: machineDenyingPageAgents }),
        );
        const decision = await directory.isMachineAccessible(pageContext, { kind: 'existing', machineId: 't1' });
        expect(decision.allowed).toBe(false);
        if (decision.allowed) return;
        expect(decision.code).toBe('page_agents_disabled');
        expect(decision.reason).toContain('does not allow page agents');
      });

      it('given a sub-agent (parentAgentId), should be treated as page-scoped and denied when allowPageAgents=false', async () => {
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ findPage: machineDenyingPageAgents }),
        );
        const decision = await directory.isMachineAccessible(
          { userId: 'u1', parentAgentId: 'parent-agent-1' },
          { kind: 'existing', machineId: 't1' },
        );
        expect(decision.allowed).toBe(false);
      });

      it('given a sub-agent (parentAgentId only, no chatSource), the user-scoped exemption should NOT apply — it keys off chatSource.agentPageId, not parentAgentId', async () => {
        // isUserScopedAgent would allow ANY id through, proving the exemption
        // check never even fires: getAgentPageId(context) is undefined here
        // (no chatSource.type==='page'), so deps.isUserScopedAgent is never called.
        const isUserScopedAgent = async () => true;
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ findPage: machineDenyingPageAgents, isUserScopedAgent }),
        );
        const decision = await directory.isMachineAccessible(
          { userId: 'u1', parentAgentId: 'parent-agent-1' },
          { kind: 'existing', machineId: 't1' },
        );
        expect(decision).toMatchObject({ allowed: false, code: 'page_agents_disabled' });
      });

      it('given a page-scoped agent and allowPageAgents=true, should allow', async () => {
        const directory = createMachineDirectory(makeMachineDirectoryDeps());
        await expect(
          directory.isMachineAccessible(pageContext, { kind: 'existing', machineId: 't1' }),
        ).resolves.toEqual({ allowed: true });
      });

      it('given the GLOBAL assistant and allowPageAgents=false, should allow (the flag only gates page agents)', async () => {
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ findPage: machineDenyingPageAgents }),
        );
        await expect(
          directory.isMachineAccessible(globalContext, { kind: 'existing', machineId: 't1' }),
        ).resolves.toEqual({ allowed: true });
      });

      it('given a page-scoped agent that also cannot view the page, should deny WITHOUT the toggle reason (no title leak)', async () => {
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ findPage: machineDenyingPageAgents, canViewPage: async () => false }),
        );
        await expect(
          directory.isMachineAccessible(pageContext, { kind: 'existing', machineId: 't1' }),
        ).resolves.toEqual({ allowed: false });
      });

      it('given a USER-SCOPED page agent and allowPageAgents=false, should allow — it acts with the invoking user\'s own reach (mirroring canActorViewPage\'s resolveActingAgentId fallthrough), not the narrower page-agent class the toggle targets', async () => {
        const isUserScopedAgent = async (agentPageId: string) => agentPageId === 'agent-1';
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ findPage: machineDenyingPageAgents, isUserScopedAgent }),
        );
        await expect(
          directory.isMachineAccessible(pageContext, { kind: 'existing', machineId: 't1' }),
        ).resolves.toEqual({ allowed: true });
      });

      it('given a user-scoped page agent, should still be denied when the actor cannot VIEW the page (the exemption only bypasses the toggle, not view permissions)', async () => {
        const isUserScopedAgent = async () => true;
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ canViewPage: async () => false, isUserScopedAgent }),
        );
        await expect(
          directory.isMachineAccessible(pageContext, { kind: 'existing', machineId: 't1' }),
        ).resolves.toEqual({ allowed: false });
      });

      it('given a NON-user-scoped page agent (isUserScopedAgent returns false for it), should still be denied by allowPageAgents=false', async () => {
        const isUserScopedAgent = async (agentPageId: string) => agentPageId === 'some-other-agent';
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ findPage: machineDenyingPageAgents, isUserScopedAgent }),
        );
        const decision = await directory.isMachineAccessible(pageContext, { kind: 'existing', machineId: 't1' });
        expect(decision).toMatchObject({ allowed: false, code: 'page_agents_disabled' });
      });
    });

    describe('machine-bound "PageSpace Agent" panes (machineBinding)', () => {
      const machineDenyingPageAgents = async () => ({
        title: 'Locked Machine',
        type: 'MACHINE',
        driveId: 'drive-1',
        isTrashed: false,
        allowPageAgents: false,
        visibleToGlobalAssistant: true,
      });

      it('given the BOUND machine, should allow even though its allowPageAgents toggle is off — the binding IS the entitlement', async () => {
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ findPage: machineDenyingPageAgents }),
        );
        const context: ToolExecutionContext = {
          userId: 'u1',
          chatSource: { type: 'page', agentPageId: 'agent-1' },
          machineBinding: boundTo('t1', '/workspace'),
        };
        await expect(
          directory.isMachineAccessible(context, { kind: 'existing', machineId: 't1' }),
        ).resolves.toEqual({ allowed: true });
      });

      it('given a DIFFERENT machine than the one bound, should keep the full toggle checks and deny', async () => {
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ findPage: machineDenyingPageAgents }),
        );
        const context: ToolExecutionContext = {
          userId: 'u1',
          chatSource: { type: 'page', agentPageId: 'agent-1' },
          machineBinding: boundTo('bound-1', '/workspace'),
        };
        const decision = await directory.isMachineAccessible(context, { kind: 'existing', machineId: 't1' });
        expect(decision).toMatchObject({ allowed: false, code: 'page_agents_disabled' });
      });

      it('given the BOUND machine but its page is trashed, should still deny — existence/trash checks are never bypassed', async () => {
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({
            findPage: async () => ({
              title: 'Trashed Machine',
              type: 'MACHINE',
              driveId: 'drive-1',
              isTrashed: true,
              allowPageAgents: false,
              visibleToGlobalAssistant: true,
            }),
          }),
        );
        const context: ToolExecutionContext = {
          userId: 'u1',
          chatSource: { type: 'page', agentPageId: 'agent-1' },
          machineBinding: boundTo('t1', '/workspace'),
        };
        await expect(
          directory.isMachineAccessible(context, { kind: 'existing', machineId: 't1' }),
        ).resolves.toEqual({ allowed: false });
      });

      it('given a machine reached only through a NON-self handle of the set, should exempt it too — membership is the policy, not self-identity', async () => {
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ findPage: machineDenyingPageAgents }),
        );
        const context: ToolExecutionContext = {
          userId: 'u1',
          chatSource: { type: 'page', agentPageId: 'agent-1' },
          machineBinding: setOf(
            { kind: 'machine', machineId: 'bound-1', cwd: '/workspace' },
            { kind: 'project', machineId: 't1', project: 'repo', cwd: '/workspace/repo' },
          ),
        };
        await expect(
          directory.isMachineAccessible(context, { kind: 'existing', machineId: 't1' }),
        ).resolves.toEqual({ allowed: true });
      });

      it('given the BOUND machine but the actor cannot view its page, should still deny — canActorViewPage is never bypassed', async () => {
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ findPage: machineDenyingPageAgents, canViewPage: async () => false }),
        );
        const context: ToolExecutionContext = {
          userId: 'u1',
          chatSource: { type: 'page', agentPageId: 'agent-1' },
          machineBinding: boundTo('t1', '/workspace'),
        };
        await expect(
          directory.isMachineAccessible(context, { kind: 'existing', machineId: 't1' }),
        ).resolves.toEqual({ allowed: false });
      });
    });

    describe('visibleToGlobalAssistant toggle (Machine Settings)', () => {
      const machineHiddenFromGlobal = async () => ({
        title: 'Hidden Machine',
        type: 'MACHINE',
        driveId: 'drive-1',
        isTrashed: false,
        allowPageAgents: true,
        visibleToGlobalAssistant: false,
      });

      it('given the GLOBAL assistant and visibleToGlobalAssistant=false, should deny with the toggle code and an LLM-facing reason', async () => {
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ findPage: machineHiddenFromGlobal }),
        );
        const decision = await directory.isMachineAccessible(globalContext, { kind: 'existing', machineId: 't1' });
        expect(decision.allowed).toBe(false);
        if (decision.allowed) return;
        expect(decision.code).toBe('hidden_from_global');
        expect(decision.reason).toContain('not visible to the global assistant');
      });

      it('given the GLOBAL assistant and visibleToGlobalAssistant=true, should allow', async () => {
        const directory = createMachineDirectory(makeMachineDirectoryDeps());
        await expect(
          directory.isMachineAccessible(globalContext, { kind: 'existing', machineId: 't1' }),
        ).resolves.toEqual({ allowed: true });
      });

      it('given a page-scoped agent and visibleToGlobalAssistant=false, should allow (the flag only gates the global assistant)', async () => {
        const directory = createMachineDirectory(
          makeMachineDirectoryDeps({ findPage: machineHiddenFromGlobal }),
        );
        await expect(
          directory.isMachineAccessible(pageContext, { kind: 'existing', machineId: 't1' }),
        ).resolves.toEqual({ allowed: true });
      });
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
          findPage: async () => ({ title: 'Personal Machine', type: 'MACHINE', driveId: 'home-drive-1', isTrashed: false, allowPageAgents: true, visibleToGlobalAssistant: true }),
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

    // Billing pin (epic risk 6): addressing a node DEEPER in the tree must
    // never move the money. Every handle carries the owning machine page id,
    // and that page — not the branch Sprite, not the project checkout — stays
    // the payer key and the runtime-guardrail key.
    it('given a branch-bound conversation, should key the payer on the owning MACHINE page id, not the branch', async () => {
      const seen: string[] = [];
      const directory = createMachineDirectory(
        makeMachineDirectoryDeps({
          lookupPageOwnerId: async (pageId) => {
            seen.push(pageId);
            return 'machine-owner';
          },
        }),
      );
      const binding = boundTo('t1', '/workspace/repo', { machineBranchId: 'branch-1', sandboxId: 'sbx-1' });
      const context: ToolExecutionContext = { userId: 'u1', machineBinding: binding };
      await expect(
        directory.resolveTenantId?.(context, { kind: 'existing', machineId: binding.self.machineId }, 'ambient-tenant'),
      ).resolves.toBe('machine-owner');
      expect(seen).toEqual(['t1']);
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

// Field bug (pagespace.ai prod): every machine-pane PageSpace Agent was denied
// by its own bash/git_* tools. chat/route.ts sets chatSource.agentPageId to the
// MACHINE page id, so the acting-agent gate authorized as a page that is not an
// agent and canActorViewPage denied before the binding exemption could apply.
// Wired to the REAL canActorViewPage so the fix is pinned end-to-end.
describe('machine-pane agents (agentPageId is the MACHINE page) — real canActorViewPage', () => {
  const FULL = { canView: true, canEdit: true, canShare: true, canDelete: true };
  const machinePaneContext: ToolExecutionContext = {
    userId: 'u1',
    chatSource: { type: 'page', agentPageId: 't1' },
    machineBinding: boundTo('t1', '/workspace'),
  };
  // The acting-page row the gate reads: the MACHINE page the pane is bound to.
  const machinePageRow = [{ type: 'MACHINE', userScopedAccess: false }];

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWhere.mockResolvedValue(machinePageRow);
    mockGetUserAccessLevel.mockResolvedValue(FULL);
    mockGetAgentAccessLevel.mockResolvedValue(null);
  });

  const directoryWithRealViewCheck = (overrides: Partial<MachineDirectoryRuntimeDeps> = {}) =>
    createMachineDirectory(makeMachineDirectoryDeps({ canViewPage: canActorViewPage, ...overrides }));

  it('given a bound machine and a user with page access, should allow — authorized as the USER, matching the PTY path', async () => {
    await expect(
      directoryWithRealViewCheck().isMachineAccessible(machinePaneContext, { kind: 'existing', machineId: 't1' }),
    ).resolves.toEqual({ allowed: true });
    expect(mockGetUserAccessLevel).toHaveBeenCalledWith('u1', 't1');
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('given a bound machine whose page is TRASHED, should still deny', async () => {
    const directory = directoryWithRealViewCheck({
      findPage: async () => ({
        title: 'Trashed Machine',
        type: 'MACHINE',
        driveId: 'drive-1',
        isTrashed: true,
        allowPageAgents: true,
        visibleToGlobalAssistant: true,
      }),
    });
    await expect(
      directory.isMachineAccessible(machinePaneContext, { kind: 'existing', machineId: 't1' }),
    ).resolves.toEqual({ allowed: false });
  });

  it('given a bound machine whose page is MISSING, should still deny', async () => {
    const directory = directoryWithRealViewCheck({ findPage: async () => undefined });
    await expect(
      directory.isMachineAccessible(machinePaneContext, { kind: 'existing', machineId: 't1' }),
    ).resolves.toEqual({ allowed: false });
  });

  it('given a bound id that is not a MACHINE page, should still deny', async () => {
    const directory = directoryWithRealViewCheck({
      findPage: async () => ({
        title: 'Not a machine',
        type: 'DOCUMENT',
        driveId: 'drive-1',
        isTrashed: false,
        allowPageAgents: true,
        visibleToGlobalAssistant: true,
      }),
    });
    await expect(
      directory.isMachineAccessible(machinePaneContext, { kind: 'existing', machineId: 't1' }),
    ).resolves.toEqual({ allowed: false });
  });

  it('given an UNBOUND existing machine the user genuinely cannot view, should deny — the type gate grants nothing on its own', async () => {
    mockGetUserAccessLevel.mockResolvedValue(null);
    const unboundContext: ToolExecutionContext = {
      userId: 'u1',
      chatSource: { type: 'page', agentPageId: 'machine-page-1' },
    };
    await expect(
      directoryWithRealViewCheck().isMachineAccessible(unboundContext, { kind: 'existing', machineId: 't1' }),
    ).resolves.toEqual({ allowed: false });
  });
});
