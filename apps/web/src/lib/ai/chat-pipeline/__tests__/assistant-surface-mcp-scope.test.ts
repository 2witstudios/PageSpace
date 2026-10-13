// @vitest-environment node
/**
 * IMG-10.10 — the assistant surface honors the drive-scope ceiling (review
 * finding on the owner's-Imago branch).
 *
 * A drive-scoped principal (a drive-scoped MCP token, or a dispatched worker
 * carrying its inherited ceiling) must not be ADVERTISED account-level-only
 * tools on the owner's Imago page — the same listing invariant the non-Imago
 * page branch upholds by wrapping `pageSpaceTools` in `filterToolsForMcpScope`.
 * `selectAssistantTools` now applies that filter BEFORE the core/deferred
 * split, so every advertised surface agrees: the up-front tools, the
 * `execute_tool`/`tool_search` corpus (both derived from `allTools`), and the
 * non-core catalog prompt. Execution-time gates were never the gap; this is
 * about what the model is told exists.
 *
 * Unit-level seam test: the real registry through the real filter chain, the
 * database mocked away (the command catalog degrades to empty).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      commands: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));

import { selectAssistantTools } from '../assistant-surface';
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';
import { ACCOUNT_LEVEL_ONLY_TOOLS } from '@/lib/ai/core/tool-filtering';

const baseInput = {
  userId: 'user_mcp_scope',
  readOnly: false,
  webSearch: false,
  imageGen: false,
  isAdmin: false,
  sandboxTierEligible: true,
  commandDriveId: null,
};

describe('selectAssistantTools — drive-scoped principal', () => {
  it('control: the registry carries create_drive and an unscoped selection advertises it on every surface', async () => {
    expect(pageSpaceTools.create_drive).toBeDefined();

    const selection = await selectAssistantTools({ ...baseInput, driveScoped: false });

    expect(Object.keys(selection.allTools)).toContain('create_drive');
    expect(selection.nonCoreToolNames).toContain('create_drive');
  });

  it('given a drive-scoped principal, should advertise no account-level-only tool on any surface', async () => {
    const selection = await selectAssistantTools({ ...baseInput, driveScoped: true });

    const surfaces = {
      allTools: Object.keys(selection.allTools),
      upFront: Object.keys(selection.tools),
      deferredCatalog: selection.nonCoreToolNames,
    };
    for (const [surface, names] of Object.entries(surfaces)) {
      for (const name of ACCOUNT_LEVEL_ONLY_TOOLS) {
        expect(names, surface).not.toContain(name);
      }
    }

    // And the deferred dispatcher answers the filtered-out name as unknown,
    // not as a tool awaiting permission.
    const execute = selection.tools.execute_tool.execute as (
      input: { tool_name: string; parameters: Record<string, unknown> },
      options: unknown,
    ) => Promise<unknown>;
    const result = await execute({ tool_name: 'create_drive', parameters: {} }, {}) as { error: string };
    expect(result.error).toMatch(/^Unknown tool "create_drive"\./);
  });

  it('given a drive-scoped principal, should differ from the unscoped selection by exactly the account-level-only tools', async () => {
    const unscoped = await selectAssistantTools({ ...baseInput, driveScoped: false });
    const scoped = await selectAssistantTools({ ...baseInput, driveScoped: true });

    const dropped = Object.keys(unscoped.allTools).filter((name) => !Object.hasOwn(scoped.allTools, name));
    expect(dropped).toEqual([...ACCOUNT_LEVEL_ONLY_TOOLS]);
    expect(Object.keys(scoped.allTools).filter((name) => !Object.hasOwn(unscoped.allTools, name))).toEqual([]);
  });
});
