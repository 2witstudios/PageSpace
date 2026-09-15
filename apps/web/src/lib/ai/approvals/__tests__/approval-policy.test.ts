import { describe, it } from 'vitest';
import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import {
  applyApprovalPolicy,
  decideApproval,
  isApprovalGatedTool,
  isToolApprovalMode,
  resolveEffectiveToolName,
  type ApprovalPolicyContext,
} from '../approval-policy';

const interactiveAsk = (over: Partial<ApprovalPolicyContext> = {}): ApprovalPolicyContext => ({
  mode: 'ask',
  interactive: true,
  conversationId: 'conv-1',
  grants: [],
  ...over,
});

describe('resolveEffectiveToolName', () => {
  it('unwraps execute_tool to the tool it dispatches', () => {
    assert({
      given: 'execute_tool with tool_name',
      should: 'return the inner name',
      actual: resolveEffectiveToolName('execute_tool', { tool_name: 'trash_page', parameters: {} }),
      expected: 'trash_page',
    });
  });

  it('leaves every other tool alone', () => {
    assert({
      given: 'a direct tool call carrying a tool_name-shaped input',
      should: 'keep the outer name',
      actual: resolveEffectiveToolName('read_page', { tool_name: 'trash_page' }),
      expected: 'read_page',
    });
  });

  it('falls back to the outer name when the dispatcher input is unusable', () => {
    assert({
      given: 'execute_tool with no input yet (still streaming)',
      should: 'return execute_tool, which is never gated',
      actual: resolveEffectiveToolName('execute_tool', undefined),
      expected: 'execute_tool',
    });
    assert({
      given: 'execute_tool with an empty tool_name',
      should: 'return execute_tool',
      actual: resolveEffectiveToolName('execute_tool', { tool_name: '' }),
      expected: 'execute_tool',
    });
  });
});

describe('isApprovalGatedTool', () => {
  it.each([
    ['trash_page', true],
    ['replace_lines', true],
    ['spawn_session', true],
    ['bash', true],
    ['send_channel_message', true],
    ['mcp__github__create_issue', true],
    ['mcp:github:create_issue', true],
    ['read_page', false],
    ['regex_search', false],
    ['list_drives', false],
    ['finish', false],
    ['ask_user', false],
    ['tool_search', false],
    ['execute_tool', false],
  ])('%s → gated=%s', (name, expected) => {
    assert({ given: name, should: `be ${expected ? 'gated' : 'ungated'}`, actual: isApprovalGatedTool(name), expected });
  });

  it('gates an integration tool only when the resolver says it is not a read', () => {
    const gated = new Set(['slack_send_message']);
    assert({
      given: 'a mutating integration tool in the gated set',
      should: 'be gated',
      actual: isApprovalGatedTool('slack_send_message', gated),
      expected: true,
    });
    assert({
      given: 'a read integration tool absent from the gated set',
      should: 'not be gated',
      actual: isApprovalGatedTool('slack_list_channels', gated),
      expected: false,
    });
  });
});

describe('decideApproval', () => {
  it('asks for a write in an interactive ask-mode turn', () => {
    assert({
      given: 'trash_page, mode ask, interactive',
      should: 'ask',
      actual: decideApproval({ toolName: 'trash_page', input: {} }, interactiveAsk()),
      expected: 'ask',
    });
  });

  it('decides on the inner tool of execute_tool', () => {
    assert({
      given: 'execute_tool dispatching trash_page',
      should: 'ask',
      actual: decideApproval(
        { toolName: 'execute_tool', input: { tool_name: 'trash_page', parameters: { pageId: 'p' } } },
        interactiveAsk(),
      ),
      expected: 'ask',
    });
    assert({
      given: 'execute_tool dispatching read_page',
      should: 'allow',
      actual: decideApproval(
        { toolName: 'execute_tool', input: { tool_name: 'read_page', parameters: {} } },
        interactiveAsk(),
      ),
      expected: 'allow',
    });
  });

  it('never gates reads or the loop scaffolding', () => {
    for (const name of ['read_page', 'regex_search', 'finish', 'ask_user', 'tool_search']) {
      assert({
        given: `${name} in ask mode`,
        should: 'allow',
        actual: decideApproval({ toolName: name, input: {} }, interactiveAsk()),
        expected: 'allow',
      });
    }
  });

  it('allows everything in auto mode', () => {
    assert({
      given: 'bash, mode auto',
      should: 'allow',
      actual: decideApproval({ toolName: 'bash', input: {} }, interactiveAsk({ mode: 'auto' })),
      expected: 'allow',
    });
  });

  it('allows everything in a non-interactive turn (dispatch, workflow, trigger, channel)', () => {
    assert({
      given: 'trash_page, mode ask, no human present',
      should: 'allow — nothing to ask; the spawn or automation setup was the consent',
      actual: decideApproval({ toolName: 'trash_page', input: {} }, interactiveAsk({ interactive: false })),
      expected: 'allow',
    });
  });

  it('honours an always-allow grant', () => {
    assert({
      given: 'a user-wide grant for trash_page',
      should: 'allow',
      actual: decideApproval(
        { toolName: 'trash_page', input: {} },
        interactiveAsk({ grants: [{ toolName: 'trash_page', conversationId: null }] }),
      ),
      expected: 'allow',
    });
  });

  it('honours a conversation grant only for that conversation', () => {
    const grants = [{ toolName: 'trash_page', conversationId: 'conv-1' }];
    assert({
      given: 'a grant for this conversation',
      should: 'allow',
      actual: decideApproval({ toolName: 'trash_page', input: {} }, interactiveAsk({ grants })),
      expected: 'allow',
    });
    assert({
      given: 'the same grant seen from another conversation',
      should: 'ask',
      actual: decideApproval(
        { toolName: 'trash_page', input: {} },
        interactiveAsk({ grants, conversationId: 'conv-2' }),
      ),
      expected: 'ask',
    });
    assert({
      given: 'the same grant with no conversation id on the turn',
      should: 'ask',
      actual: decideApproval(
        { toolName: 'trash_page', input: {} },
        interactiveAsk({ grants, conversationId: null }),
      ),
      expected: 'ask',
    });
  });

  it('a grant for one tool does not cover another', () => {
    assert({
      given: 'a grant for replace_lines when trash_page is called',
      should: 'ask',
      actual: decideApproval(
        { toolName: 'trash_page', input: {} },
        interactiveAsk({ grants: [{ toolName: 'replace_lines', conversationId: null }] }),
      ),
      expected: 'ask',
    });
  });

  it('grants apply to the effective (inner) tool name', () => {
    assert({
      given: 'an always-allow grant for trash_page, called via execute_tool',
      should: 'allow',
      actual: decideApproval(
        { toolName: 'execute_tool', input: { tool_name: 'trash_page' } },
        interactiveAsk({ grants: [{ toolName: 'trash_page', conversationId: null }] }),
      ),
      expected: 'allow',
    });
  });
});

describe('isToolApprovalMode', () => {
  it.each([
    ['ask', true],
    ['auto', true],
    ['deny', false],
    [undefined, false],
    [1, false],
  ])('%s → %s', (value, expected) => {
    assert({ given: String(value), should: `be ${expected}`, actual: isToolApprovalMode(value), expected });
  });
});

describe('applyApprovalPolicy', () => {
  const exec = async () => ({ ok: true });
  const schema = z.object({});
  const mk = (over: Partial<Tool> = {}): Tool => ({ description: 'd', inputSchema: schema, execute: exec, ...over }) as unknown as Tool;
  const tools: ToolSet = {
    read_page: mk(),
    trash_page: mk(),
    execute_tool: mk({ inputSchema: z.object({ tool_name: z.string(), parameters: z.record(z.string(), z.unknown()) }) }),
    ask_user: { description: 'pause', inputSchema: schema },
    mcp__srv__do_thing: mk(),
    provider_thing: { ...mk(), type: 'provider' } as unknown as Tool,
  };

  it('returns the very same set in auto mode and in a non-interactive turn', () => {
    assert({
      given: 'auto mode',
      should: 'return the input reference',
      actual: applyApprovalPolicy(tools, interactiveAsk({ mode: 'auto' })) === tools,
      expected: true,
    });
    assert({
      given: 'a non-interactive turn',
      should: 'return the input reference',
      actual: applyApprovalPolicy(tools, interactiveAsk({ interactive: false })) === tools,
      expected: true,
    });
  });

  it('wraps only gated tools that have an execute, leaving the rest as the same objects', () => {
    const out = applyApprovalPolicy(tools, interactiveAsk());
    assert({ given: 'read_page', should: 'be the identical object', actual: out.read_page === tools.read_page, expected: true });
    assert({ given: 'ask_user (execute-less)', should: 'be the identical object', actual: out.ask_user === tools.ask_user, expected: true });
    assert({ given: 'a provider tool', should: 'be the identical object', actual: out.provider_thing === tools.provider_thing, expected: true });
    assert({ given: 'trash_page', should: 'gain needsApproval', actual: typeof out.trash_page.needsApproval, expected: 'function' });
    assert({ given: 'mcp__srv__do_thing', should: 'gain needsApproval', actual: typeof out.mcp__srv__do_thing.needsApproval, expected: 'function' });
    assert({ given: 'execute_tool', should: 'gain needsApproval', actual: typeof out.execute_tool.needsApproval, expected: 'function' });
  });

  it('keeps schema, description and execute on a wrapped tool', () => {
    const out = applyApprovalPolicy(tools, interactiveAsk());
    assert({
      given: 'a wrapped tool',
      should: 'keep its fields',
      actual: [out.trash_page.description, out.trash_page.inputSchema === schema, out.trash_page.execute === exec],
      expected: ['d', true, true],
    });
  });

  it('needsApproval follows the decision, including through execute_tool', async () => {
    const out = applyApprovalPolicy(tools, interactiveAsk());
    const ask = async (name: string, input: unknown) =>
      (out[name].needsApproval as (i: unknown, o: unknown) => Promise<boolean>)(input, { toolCallId: 'c', messages: [] });
    assert({ given: 'trash_page', should: 'need approval', actual: await ask('trash_page', {}), expected: true });
    assert({ given: 'execute_tool → trash_page', should: 'need approval', actual: await ask('execute_tool', { tool_name: 'trash_page' }), expected: true });
    assert({ given: 'execute_tool → read_page', should: 'not need approval', actual: await ask('execute_tool', { tool_name: 'read_page' }), expected: false });
  });

  it('a grant turns a wrapped tool back to no-approval without changing the set shape', async () => {
    const out = applyApprovalPolicy(tools, interactiveAsk({ grants: [{ toolName: 'trash_page', conversationId: null }] }));
    const needs = await (out.trash_page.needsApproval as (i: unknown, o: unknown) => Promise<boolean>)({}, { toolCallId: 'c', messages: [] });
    assert({ given: 'an always-allow grant', should: 'not need approval', actual: needs, expected: false });
  });
});
