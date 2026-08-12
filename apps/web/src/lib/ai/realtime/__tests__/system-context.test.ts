/**
 * What a call actually knows.
 *
 * The bug this module exists to fix was invisible: `tool_search` and
 * `execute_tool` rode every session while nothing in the prompt named them, so
 * every deferred tool — the calendar family, `spawn_session`, `create_task`,
 * the workflow tools — was loaded and undiscoverable, and the model answered
 * "I can't do that" about tools it was holding. So the cases that matter most
 * are the ones about the discovery block and the tool names in it.
 *
 * The rest are about not letting one failed read cost the call.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import type { Tool } from 'ai';
import {
  buildVoiceSystemContext,
  type VoiceSystemContextDeps,
  type BoundAgent,
} from '../system-context';
import { buildPageSpaceTools } from '../../core/ai-tools';

const fakeTool = (description = 'A tool.'): Tool =>
  ({
    description,
    inputSchema: z.object({ pageId: z.string() }),
    execute: async () => ({}),
  }) as Tool;

/** One core tool and two deferred ones, so there is something to discover. */
const smallRegistry = (): ToolSet => ({
  read_page: fakeTool('Read a page.'),
  create_task: fakeTool('Create a task.'),
  spawn_session: fakeTool('Spawn a worker session.'),
});

const agent = (over: Partial<BoundAgent> = {}): BoundAgent => ({
  pageId: 'agent1',
  title: 'Release Notes Bot',
  systemPrompt: null,
  enabledTools: null,
  ...over,
});

function deps(over: Partial<VoiceSystemContextDeps> = {}) {
  const warn = vi.fn();
  const base: VoiceSystemContextDeps = {
    buildTools: () => smallRegistry(),
    loadAgentMemory: vi.fn(async () => '\n\n<<MEMORY>>'),
    loadActivePlan: vi.fn(async () => '\n\n<<PLAN>>'),
    loadAgentAwareness: vi.fn(async () => '<<AGENTS>>'),
    loadPersonalization: vi.fn(async () => ({ enabled: true, bio: 'Ships release notes.' })),
    logger: { warn },
    ...over,
  };
  return { deps: base, warn };
}

/**
 * The catalog block, sliced out of the prompt.
 *
 * Asserted against the SECTION rather than the whole string: several of these
 * tool names also appear in the workspace-knowledge prose, so a whole-string
 * `toContain('spawn_session')` passes with the catalog entirely absent — which
 * is precisely the bug, and a mutation check caught these two tests passing
 * that way.
 */
const catalog = (prompt: string): string => {
  const at = prompt.indexOf('NON-CORE TOOLS');
  return at === -1 ? '' : prompt.slice(at);
};

describe('buildVoiceSystemContext — reaching the tools it is holding', () => {
  it('should tell the model how to reach the tools that are not advertised', async () => {
    const { deps: d } = deps();

    const prompt = await buildVoiceSystemContext(d, { userId: 'u1' });

    expect(prompt).toContain('call execute_tool');
    expect(prompt).toContain('tool_search("select:tool_name")');
  });

  it('should NAME the deferred tools, which is the whole delegation surface', async () => {
    const { deps: d } = deps();

    const listed = catalog(await buildVoiceSystemContext(d, { userId: 'u1' }));

    expect(listed).toContain('create_task');
    expect(listed).toContain('spawn_session');
  });

  it('given the real registry, should name tools a call could never reach before', async () => {
    // Against the actual product registry, not a fixture: the failure this
    // guards is "the model refuses a request it has the tool for", and the
    // tools in question are real ones.
    const { deps: d } = deps({ buildTools: () => buildPageSpaceTools() });

    const listed = catalog(await buildVoiceSystemContext(d, { userId: 'u1' }));

    for (const name of ['create_task', 'spawn_session', 'list_calendar_events', 'create_workflow']) {
      expect(listed, `${name} is not discoverable on a call`).toContain(name);
    }
  });

  it("should describe only the tools the agent's owner left switched on", async () => {
    // A name in the prompt is an invitation to call it. Naming a blocked tool
    // both leaks the agent's configuration and spends a turn on a refusal.
    const { deps: d } = deps();

    const listed = catalog(
      await buildVoiceSystemContext(d, {
        userId: 'u1',
        agent: agent({ enabledTools: ['read_page', 'create_task'] }),
      }),
    );

    expect(listed).toContain('create_task');
    expect(listed).not.toContain('spawn_session');
  });

  it('should carry the workspace knowledge, gated on those same tools', async () => {
    const { deps: d } = deps();

    const prompt = await buildVoiceSystemContext(d, { userId: 'u1' });

    expect(prompt).toContain('# PAGESPACE AI');
    expect(prompt).toMatch(/TASK/i);
  });
});

describe('buildVoiceSystemContext — which assistant it assembles', () => {
  it("given a bound agent with its own prompt, should carry it VERBATIM and skip our persona", async () => {
    const systemPrompt = 'Answer only in limericks. Never mention the weather.';
    const { deps: d } = deps();

    const prompt = await buildVoiceSystemContext(d, {
      userId: 'u1',
      agent: agent({ systemPrompt }),
    });

    expect(prompt).toContain(systemPrompt);
    expect(prompt).not.toContain('# PAGESPACE AI');
  });

  it('given a bound agent, should carry its memory', async () => {
    const { deps: d } = deps();

    const prompt = await buildVoiceSystemContext(d, { userId: 'u1', agent: agent() });

    expect(prompt).toContain('<<MEMORY>>');
    expect(d.loadAgentMemory).toHaveBeenCalledWith('agent1', 'u1');
  });

  it('given NO bound agent, should assemble the Global Assistant, agents and all', async () => {
    const { deps: d } = deps();

    const prompt = await buildVoiceSystemContext(d, { userId: 'u1' });

    expect(prompt).toContain('You are the Global Assistant for PageSpace');
    expect(prompt).toContain('<<AGENTS>>');
  });

  it('should carry the caller\'s own personalization, same as the typed surface', async () => {
    const { deps: d } = deps();

    const prompt = await buildVoiceSystemContext(d, { userId: 'u1' });

    expect(prompt).toContain('ABOUT THE USER');
    expect(prompt).toContain('Ships release notes.');
  });

  it('given a bound conversation, should carry its plan pointer', async () => {
    const { deps: d } = deps();

    const prompt = await buildVoiceSystemContext(d, { userId: 'u1', conversationId: 'conv1' });

    expect(prompt).toContain('<<PLAN>>');
    expect(d.loadActivePlan).toHaveBeenCalledWith('conv1', 'u1');
  });

  it('given an UNBOUND call, should not go looking for a plan there is no thread for', async () => {
    const { deps: d } = deps();

    await buildVoiceSystemContext(d, { userId: 'u1' });

    expect(d.loadActivePlan).not.toHaveBeenCalled();
  });

  it('should never describe ask_user, which draws a card nobody on a call can see', async () => {
    const { deps: d } = deps();

    expect(await buildVoiceSystemContext(d, { userId: 'u1' })).not.toContain('ASKING THE USER:');
  });

  it('should carry NOTHING turn-volatile — instructions are sent once, at socket open', async () => {
    // The caller can walk to another page mid-call without the session
    // rebinding, so a location or a clock frozen here goes quietly wrong. The
    // tools read the live location instead.
    const { deps: d } = deps();

    const prompt = await buildVoiceSystemContext(d, { userId: 'u1', agent: agent() });

    expect(prompt).not.toContain('LOCATION CONTEXT');
    expect(prompt).not.toMatch(/CURRENT (DATE|TIME)/i);
  });
});

describe('buildVoiceSystemContext — what it costs the session', () => {
  /**
   * A call's context window is shared with the audio flowing through it for as
   * long as the call lasts, and the seed already reserves 4k on top of this. At
   * the time of writing the real registry assembles to roughly 9k characters
   * (~2.3k tokens), which is comfortable; this ceiling is set well above that so
   * it fails on a block that doubled rather than on ordinary drift.
   *
   * If it fails, the order to cut in is: page tree (already omitted) →
   * personalization → agent memory → skill catalog. The tool catalog is the LAST
   * thing to cut — it is what makes a call something you can delegate to.
   */
  const CEILING_CHARS = 20_000;

  it('should assemble well inside the session context it shares with the audio', async () => {
    const { deps: d } = deps({ buildTools: () => buildPageSpaceTools() });

    const prompt = await buildVoiceSystemContext(d, { userId: 'u1' });

    expect(prompt.length, `assembled prompt is ${prompt.length} characters`).toBeLessThan(
      CEILING_CHARS,
    );
  });
});

describe('buildVoiceSystemContext — no block is worth the call', () => {
  const failing = () => async () => {
    throw new Error('database is down');
  };

  it.each([
    ['loadActivePlan', '<<PLAN>>'],
    ['loadAgentMemory', '<<MEMORY>>'],
    ['loadPersonalization', 'ABOUT THE USER'],
  ] as const)('given %s fails, should drop only that block', async (dep, marker) => {
    const { deps: d, warn } = deps({ [dep]: failing() });

    const prompt = await buildVoiceSystemContext(d, {
      userId: 'u1',
      conversationId: 'conv1',
      agent: agent(),
    });

    expect(prompt).not.toContain(marker);
    // Everything the call actually needs is still there.
    expect(prompt).toContain('execute_tool');
    expect(warn).toHaveBeenCalled();
  });

  it('given a failed read, should name which block gave up', async () => {
    // A dropped block shows up as a model that has quietly stopped knowing
    // something — invisible in a transcript, impossible to bisect without this.
    const { deps: d, warn } = deps({ loadActivePlan: failing() });

    await buildVoiceSystemContext(d, { userId: 'u1', conversationId: 'conv1' });

    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ block: 'activePlan' }),
    );
  });

  it('given the agent-awareness read fails, should still assemble the Global Assistant', async () => {
    const { deps: d } = deps({ loadAgentAwareness: failing() });

    const prompt = await buildVoiceSystemContext(d, { userId: 'u1' });

    expect(prompt).toContain('You are the Global Assistant for PageSpace');
    expect(prompt).not.toContain('<<AGENTS>>');
  });
});
