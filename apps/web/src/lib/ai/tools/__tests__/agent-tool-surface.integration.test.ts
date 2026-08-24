/**
 * The stored-config → runtime-surface answer, against a REAL agent row and the
 * REAL tool registry (issue #2460).
 *
 * The unit tests pin the classification with hand-written name lists. That is
 * exactly the shape of evidence that failed the reporter: their config named
 * `read_file`, the registry's tool is `readFile`, and every layer accepted the
 * string. What a fake registry cannot catch:
 *
 *  - the runtime dep reading the WRONG COLUMNS (`sandboxEnabled` /
 *    `toolExposureMode` are new to this query — a typo would silently read
 *    undefined and report every sandbox tool as blocked, forever);
 *  - `SANDBOX_TOOL_NAMES` drifting from the names actually registered in
 *    `pageSpaceTools`, which would make the refusal fire on nothing;
 *  - the whole thing throwing on a real page row.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable —
 * a silent skip would be a green, zero-assertion pass. Local runs without
 * Docker opt out explicitly with ALLOW_SKIP_DB_TESTS=1. Mirrors the other
 * integration tests in this repo.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { buildSessionToolsDeps } from '@/lib/ai/tools/session-tools-runtime';

let dbAvailable = false;

async function createAgent(enabledTools: string[] | null, sandboxEnabled: boolean) {
  const owner = await factories.createUser();
  const drive = await factories.createDrive(owner.id);
  const agent = await factories.createPage(drive.id, {
    type: 'AI_CHAT',
    title: 'Scraper Runner',
    enabledTools,
    sandboxEnabled,
  });
  return { owner, agent };
}

describe('describeAgentToolSurface against a real agent row (issue #2460)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('agent-tool-surface.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  it('reports the reporter\'s exact config as blocked by the sandbox switch, using the real registry', async () => {
    if (!dbAvailable) return;

    // The names from the issue, spelled the way the tool registry spells them.
    const { agent } = await createAgent(
      ['read_page', 'bash', 'writeFile', 'readFile', 'spawn_shell', 'git_clone'],
      false,
    );

    const surface = await buildSessionToolsDeps().describeAgentToolSurface(agent.id);
    expect(surface).not.toBeNull();

    expect(surface!.granted).toEqual(['read_page']);
    expect(surface!.blocked.map((entry) => entry.tool).sort()).toEqual(
      ['bash', 'git_clone', 'readFile', 'spawn_shell', 'writeFile'].sort(),
    );
    // Every one of them by the SWITCH, not by "no such tool" — if these names
    // had drifted from the registry the gate would read `not_registered` and
    // the refusal would point at the wrong fix.
    expect(surface!.blocked.every((entry) => entry.gate === 'sandbox_disabled')).toBe(true);
    expect(surface!.notes.join(' ')).toContain('sandboxEnabled');
  });

  it('grants exactly the same list once the switch is on — the column is what changes the answer', async () => {
    if (!dbAvailable) return;

    const { agent } = await createAgent(['read_page', 'bash', 'spawn_shell'], false);
    await db.update(pages).set({ sandboxEnabled: true }).where(eq(pages.id, agent.id));

    const surface = await buildSessionToolsDeps().describeAgentToolSurface(agent.id);

    expect(surface!.blocked).toEqual([]);
    expect(surface!.granted).toEqual(['read_page', 'bash', 'spawn_shell']);
    expect(surface!.notes).toEqual([]);
  });

  it('reports a misspelled tool name as not_registered — `read_file` is not `readFile`', async () => {
    if (!dbAvailable) return;

    const { agent } = await createAgent(['read_file'], true);

    const surface = await buildSessionToolsDeps().describeAgentToolSurface(agent.id);

    expect(surface!.blocked).toEqual([{ tool: 'read_file', gate: 'not_registered' }]);
    expect(surface!.granted).toEqual([]);
  });

  it('reads toolExposureMode from the row: search mode defers the non-core tools it grants', async () => {
    if (!dbAvailable) return;

    const { agent } = await createAgent(['read_page', 'trash_page'], false);
    await db.update(pages).set({ toolExposureMode: 'search' }).where(eq(pages.id, agent.id));

    const surface = await buildSessionToolsDeps().describeAgentToolSurface(agent.id);

    expect(surface!.granted).toEqual(['read_page', 'trash_page']);
    // read_page is core and stays upfront; trash_page is reached through
    // tool_search/execute_tool.
    expect(surface!.deferred).toEqual(['trash_page']);
    expect(surface!.blocked).toEqual([]);
  });

  it('classifies the composer-toggle pair as conditional, never granted', async () => {
    if (!dbAvailable) return;

    const { agent } = await createAgent(['read_page', 'web_search'], true);

    const surface = await buildSessionToolsDeps().describeAgentToolSurface(agent.id);

    expect(surface!.granted).toEqual(['read_page']);
    expect(surface!.conditional).toEqual(['web_search']);
    expect(surface!.notes.join(' ')).toContain('composer toggle');
  });

  it('returns null for a page that is not an agent, so a spawn cannot be refused by a stale id', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const document = await factories.createPage(drive.id, { type: 'DOCUMENT' });

    expect(await buildSessionToolsDeps().describeAgentToolSurface(document.id)).toBeNull();
  });
});
