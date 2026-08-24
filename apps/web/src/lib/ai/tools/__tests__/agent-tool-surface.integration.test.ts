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
 * THE KILL SWITCH IS PART OF THE FIXTURE. `pageSpaceTools` registers the
 * compute families only when `CODE_EXECUTION_ENABLED === 'true'`, evaluated once
 * at module load, and CI leaves it off. Without the stub below, `bash` and
 * friends are simply absent from the registry and every assertion here passes
 * for the WRONG reason — the classification comes back `not_registered`, which
 * is correct for a deployment that offers no sandbox but proves nothing about
 * the switch this PR is about. That is not hypothetical: the first CI run of
 * this file failed exactly that way, which is the whole argument for testing
 * against the real registry rather than a hand-written name list.
 *
 * The switch is set in `beforeAll`, which still lands before any import of the
 * registry (the production dep loads it lazily, at call time), and the same
 * hook FAILS LOUDLY if the sandbox family is not registered afterwards — so this
 * suite can never quietly degrade into the other deployment's answer.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable —
 * a silent skip would be a green, zero-assertion pass. Local runs without
 * Docker opt out explicitly with ALLOW_SKIP_DB_TESTS=1. Mirrors the other
 * integration tests in this repo.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { createId } from '@paralleldrive/cuid2';
import { resolveOrCreateConversation } from '@/lib/repositories/resolve-or-create-conversation';
import { ensureGlobalSandboxSession } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { isSandboxAvailable } from '@pagespace/lib/billing/sandbox-eligibility';
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
    // Set BEFORE the registry is first imported below: `pageSpaceTools` reads
    // this once, at module evaluation.
    vi.stubEnv('CODE_EXECUTION_ENABLED', 'true');

    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('agent-tool-surface.integration.test.ts', error);
      dbAvailable = false;
    }

    // The fixture guard: without the compute families registered, every
    // assertion below would pass as `not_registered` and prove nothing about
    // the sandbox switch.
    const { pageSpaceTools } = await import('@/lib/ai/core/ai-tools');
    expect(Object.keys(pageSpaceTools)).toContain('bash');
    expect(Object.keys(pageSpaceTools)).toContain('spawn_shell');
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

  /**
   * The EXECUTE side of a voice call, which is a different set from the one the
   * session advertises: `execute_tool` dispatches from it and `tool_search`
   * searches it. Filtering only the advertised set would leave a switched-off
   * agent's sandbox tools discoverable and runnable — half a gate.
   */
  describe('the voice bridge tool set', () => {
    // Imported INSIDE the test, not at the top of the file: this module pulls in
    // the tool registry, whose compute families are decided once at import time
    // from the kill switch `beforeAll` stubs. A static import here evaluated the
    // registry before the stub and turned the fixture guard red — the same trap
    // the header describes, arriving by a different door.
    const dispatchDeps = async (assistant: { agentPageId: string; enabledTools: string[] }) => {
      const { voiceToolDispatchDeps } = await import('@/lib/ai/realtime/voice-runtime-deps');
      return voiceToolDispatchDeps(assistant);
    };

    it('given the switch OFF, withholds the sandbox family from the executable set', async () => {
      if (!dbAvailable) return;

      const { agent } = await createAgent(['read_page', 'spawn_shell'], false);

      const deps = await dispatchDeps({
        agentPageId: agent.id,
        enabledTools: ['read_page', 'spawn_shell'],
      });

      expect(Object.keys(deps.tools)).toContain('read_page');
      expect(Object.keys(deps.tools)).not.toContain('spawn_shell');
    });

    it('given the switch ON, keeps it', async () => {
      if (!dbAvailable) return;

      const { agent } = await createAgent(['read_page', 'spawn_shell'], true);

      const deps = await dispatchDeps({
        agentPageId: agent.id,
        enabledTools: ['read_page', 'spawn_shell'],
      });

      expect(Object.keys(deps.tools)).toContain('spawn_shell');
    });

    it('given an agent page that cannot be read, fails CLOSED', async () => {
      if (!dbAvailable) return;

      const deps = await dispatchDeps({
        agentPageId: 'no-such-page-id',
        enabledTools: ['read_page', 'spawn_shell'],
      });

      expect(Object.keys(deps.tools)).not.toContain('spawn_shell');
    });
  });

  /**
   * The divergence no stored config can predict: whether the WORKSPACE the
   * worker landed in will grant compute at all. This is the runtime half — the
   * factory's fail/warn policy is unit-tested with fakes, but the question it
   * asks (which granted names are compute, and `canRunCode` against that
   * workspace's drive and owner) only exists here.
   */
  describe('describeWorkerComputeShortfall', () => {
    const workspaceFor = async (userId: string): Promise<string> => {
      const conversationId = createId();
      await resolveOrCreateConversation(userId, conversationId);
      const ensured = await ensureGlobalSandboxSession(conversationId, userId);
      if (!ensured.ok) throw new Error(`could not mint a workspace: ${ensured.reason}`);
      return ensured.session.id;
    };

    it('given an agent granted NO compute tools, should not even ask the workspace', async () => {
      if (!dbAvailable) return;

      const owner = await factories.createUser();
      const workspaceId = await workspaceFor(owner.id);

      const shortfall = await buildSessionToolsDeps().describeWorkerComputeShortfall({
        workspaceId,
        userId: owner.id,
        granted: ['read_page', 'spawn_session'],
      });

      // `spawn_session` is sandbox-family but NOT compute — sessions are free on
      // every plan, so a workspace that cannot run code still runs workers.
      expect(shortfall).toBeNull();
    });

    it('given compute tools and a free-tier workspace owner, should name the shortfall', async () => {
      if (!dbAvailable) return;

      // THE ASSUMPTION, ASSERTED. This case only means anything where a free
      // payer is ineligible — true in `cloud` (the default) but not in `tenant`,
      // where every payer resolves to an eligible effective tier. Without this
      // line, a deployment-mode change would make the test fail as though the
      // shortfall logic broke, instead of saying the environment moved.
      expect(isSandboxAvailable('free')).toBe(false);

      // `factories.createUser` mints a free-tier payer, which is exactly the
      // case the reporter kept landing in without being told.
      const owner = await factories.createUser();
      const workspaceId = await workspaceFor(owner.id);

      const shortfall = await buildSessionToolsDeps().describeWorkerComputeShortfall({
        workspaceId,
        userId: owner.id,
        granted: ['read_page', 'bash'],
      });

      expect(shortfall).not.toBeNull();
      expect(String(shortfall)).toContain('bash');
      // The OUTCOME, not a guessed cause: canRunCode folds three questions.
      expect(String(shortfall)).toContain('will NOT grant');
    });

    it('given `granted: null` (unrestricted or a global worker), should treat compute as in play', async () => {
      if (!dbAvailable) return;

      const owner = await factories.createUser();
      const workspaceId = await workspaceFor(owner.id);

      const shortfall = await buildSessionToolsDeps().describeWorkerComputeShortfall({
        workspaceId,
        userId: owner.id,
        granted: null,
      });

      // null is the WIDEST case, not "nothing" — the whole registry, compute
      // included. Reading it as an empty list would silently skip this check for
      // every unrestricted agent.
      expect(shortfall).not.toBeNull();
    });
  });
});
