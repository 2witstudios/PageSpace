/**
 * The EXECUTE side of the voice approval gate.
 *
 * A call has no approval card, so in `ask` mode the tools the text gate would
 * pause on are stripped from what the session advertises (`system-context.ts`)
 * AND from what the bridge will run — here. Without the second half a forged
 * function call (or an `execute_tool` naming a deferred gated tool) would run a
 * write the model was never offered.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import type { ApprovalPolicyContext } from '../../approvals/approval-policy';

const executed = vi.hoisted(() => [] as string[]);
const loadVoiceApprovalPolicy = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/lib/permissions/conversation-access', () => ({
  canAccessConversation: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } },
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({ conversationRepository: {} }));
vi.mock('@/lib/repositories/message-repository', () => ({ messageRepository: {} }));
vi.mock('@/lib/repositories/resolve-or-create-conversation', () => ({
  resolveOrCreateConversation: vi.fn(),
  ConversationHistoryDeletedError: class extends Error {},
  ConversationOwnershipError: class extends Error {},
}));
vi.mock('@/lib/ai/approvals/load-approval-context', () => ({ loadVoiceApprovalPolicy }));
vi.mock('@/lib/ai/core/ai-tools', () => {
  const make = (name: string): Tool =>
    ({
      description: `The ${name} tool.`,
      inputSchema: z.object({ pageId: z.string() }),
      execute: async () => {
        executed.push(name);
        return { ok: true };
      },
    }) as Tool;
  // One core read, one core write, and one deferred write (reached only
  // through `execute_tool`).
  return {
    buildPageSpaceTools: (): ToolSet => ({
      read_page: make('read_page'),
      create_page: make('create_page'),
      create_task: make('create_task'),
    }),
  };
});

import { voiceToolDispatchDeps } from '../voice-runtime-deps';
import { dispatchRealtimeToolCall } from '../tool-dispatch';

const policy = (over: Partial<ApprovalPolicyContext> = {}): ApprovalPolicyContext => ({
  mode: 'ask',
  interactive: true,
  conversationId: null,
  grants: [],
  ...over,
});

const call = (name: string, args: Record<string, unknown>) => ({
  name,
  argumentsJson: JSON.stringify(args),
  userId: 'u1',
  callId: 'rtc_1',
});

beforeEach(() => {
  executed.length = 0;
  loadVoiceApprovalPolicy.mockReset();
});

describe('voiceToolDispatchDeps — the approval gate', () => {
  it('reads the policy for the caller and the conversation', async () => {
    loadVoiceApprovalPolicy.mockResolvedValue(policy({ mode: 'auto' }));

    await voiceToolDispatchDeps(undefined, { userId: 'u1', conversationId: 'conv1' });

    expect(loadVoiceApprovalPolicy).toHaveBeenCalledWith(
      { userId: 'u1', conversationId: 'conv1' },
      expect.anything(),
    );
  });

  it('given ask mode, a forged direct call to a gated tool does not run', async () => {
    loadVoiceApprovalPolicy.mockResolvedValue(policy());
    const deps = await voiceToolDispatchDeps(undefined, { userId: 'u1' });

    expect(Object.keys(deps.tools)).toContain('read_page');
    expect(Object.keys(deps.tools)).not.toContain('create_page');

    const outcome = await dispatchRealtimeToolCall(deps, call('create_page', { pageId: 'p1' }), 'm');
    expect(outcome.failed).toBe(true);
    expect(executed).toEqual([]);
  });

  it('given ask mode, execute_tool cannot reach a deferred gated tool', async () => {
    loadVoiceApprovalPolicy.mockResolvedValue(policy());
    const deps = await voiceToolDispatchDeps(undefined, { userId: 'u1' });

    // The only deferred tool was gated, so there is no dispatcher at all.
    expect(Object.keys(deps.tools)).not.toContain('execute_tool');
    const outcome = await dispatchRealtimeToolCall(
      deps,
      call('execute_tool', { tool_name: 'create_task', parameters: { pageId: 'p1' } }),
      'm',
    );
    expect(outcome.failed).toBe(true);
    expect(executed).toEqual([]);
  });

  it('given auto mode, the gated tools run', async () => {
    loadVoiceApprovalPolicy.mockResolvedValue(policy({ mode: 'auto' }));
    const deps = await voiceToolDispatchDeps(undefined, { userId: 'u1' });

    const outcome = await dispatchRealtimeToolCall(deps, call('create_page', { pageId: 'p1' }), 'm');
    expect(outcome.failed).toBe(false);
    expect(executed).toEqual(['create_page']);
  });

  it('given ask mode and a standing grant, that tool runs and the others stay gated', async () => {
    loadVoiceApprovalPolicy.mockResolvedValue(
      policy({ grants: [{ toolName: 'create_page', conversationId: null }] }),
    );
    const deps = await voiceToolDispatchDeps(undefined, { userId: 'u1' });

    expect(Object.keys(deps.tools)).toContain('create_page');
    expect(Object.keys(deps.tools)).not.toContain('execute_tool');
    expect((await dispatchRealtimeToolCall(deps, call('create_page', { pageId: 'p1' }), 'm')).failed).toBe(false);
  });
});
