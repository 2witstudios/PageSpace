/**
 * useDualModeChat — mode selection, and the two mode-switch stops that are gone.
 *
 * The old suite's cases were almost entirely about the SDK plumbing this no longer has:
 * "should return setMessages", "should expose globalMessages for context sync", "should
 * calculate isStreaming based on status value". None of those have referents any more — the
 * hook holds no message arrays (the store renders), exposes no `stop` (there is one Stop, and
 * it POSTs to `/api/ai/abort`), and derives no `isStreaming` (streaming is a property of a
 * CONVERSATION, read from the store, not of a chat instance).
 *
 * What survives is what actually mattered: dispatch goes to the selected mode, both modes stay
 * independent, and — the leaf-5 requirement — a mode switch stops nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { useChatSession } from '@/lib/ai/shared/hooks/useChatSession';
import { useDualModeChat } from '../useDualModeChat';
import type { AgentInfo } from '@/types/agent';

const globalSession = {
  sendMessage: vi.fn(async () => {}),
  regenerate: vi.fn(async () => {}),
  addToolResult: vi.fn(async () => ({ dispatched: true })),
  clearError: vi.fn(),
  status: 'ready' as const,
  error: undefined,
};
const agentSession = {
  sendMessage: vi.fn(async () => {}),
  regenerate: vi.fn(async () => {}),
  addToolResult: vi.fn(async () => ({ dispatched: true })),
  clearError: vi.fn(),
  status: 'ready' as const,
  error: undefined,
};

let sessionCallCount = 0;

vi.mock('@/lib/ai/shared/hooks/useChatSession', () => ({
  useChatSession: vi.fn(() => {
    sessionCallCount += 1;
    // The hook builds the global shell first, then the agent one.
    return sessionCallCount % 2 === 1 ? globalSession : agentSession;
  }),
}));

const mockAgent: AgentInfo = {
  id: 'agent-123',
  title: 'Test Agent',
  driveId: 'drive-456',
  driveName: 'Test Drive',
};

const options = (selectedAgent: AgentInfo | null) => ({
  selectedAgent,
  triggeredBy: { userId: 'user-1', displayName: 'Ada' },
  global: {
    api: '/api/ai/global/conv-g/messages',
    channelId: 'global-channel',
    conversationId: 'conv-g',
    getBaseMessages: () => [] as UIMessage[],
  },
  agent: {
    api: '/api/ai/chat',
    channelId: 'agent-123',
    conversationId: 'conv-a',
    getBaseMessages: () => [] as UIMessage[],
  },
});

const message = (): UIMessage =>
  ({ id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }) as UIMessage;

beforeEach(() => {
  vi.clearAllMocks();
  sessionCallCount = 0;
});

describe('useDualModeChat — dispatch follows the selected mode', () => {
  it('given no agent, sends through the global shell', async () => {
    const { result } = renderHook(() => useDualModeChat(options(null)));

    await act(async () => {
      await result.current.sendMessage(message(), 'conv-g');
    });

    expect(globalSession.sendMessage).toHaveBeenCalledWith(expect.anything(), 'conv-g', undefined);
    expect(agentSession.sendMessage).not.toHaveBeenCalled();
  });

  it('given an agent, sends through the agent shell', async () => {
    const { result } = renderHook(() => useDualModeChat(options(mockAgent)));

    await act(async () => {
      await result.current.sendMessage(message(), 'conv-a');
    });

    expect(agentSession.sendMessage).toHaveBeenCalledWith(expect.anything(), 'conv-a', undefined);
    expect(globalSession.sendMessage).not.toHaveBeenCalled();
  });

  it('routes regenerate and addToolResult to the same mode', async () => {
    const { result } = renderHook(() => useDualModeChat(options(mockAgent)));

    await act(async () => {
      await result.current.regenerate('conv-a');
      await result.current.addToolResult({
        tool: 'ask_user',
        toolCallId: 'call-1',
        output: {},
        conversationId: 'conv-a',
      });
    });

    expect(agentSession.regenerate).toHaveBeenCalled();
    expect(agentSession.addToolResult).toHaveBeenCalled();
    expect(globalSession.regenerate).not.toHaveBeenCalled();
  });

  it('reads the mode at CALL time, so a switch between render and dispatch cannot misroute', async () => {
    const { result, rerender } = renderHook(
      ({ agent }: { agent: AgentInfo | null }) => useDualModeChat(options(agent)),
      { initialProps: { agent: null as AgentInfo | null } },
    );

    const send = result.current.sendMessage;
    rerender({ agent: mockAgent });

    // The callback captured BEFORE the switch must still land on the mode that is selected NOW.
    await act(async () => {
      await send(message(), 'conv-a');
    });

    expect(agentSession.sendMessage).toHaveBeenCalled();
    expect(globalSession.sendMessage).not.toHaveBeenCalled();
  });

  it('exposes both modes\' statuses so neither is hidden behind the other', () => {
    const { result } = renderHook(() => useDualModeChat(options(mockAgent)));

    expect(result.current.globalStatus).toBe('ready');
    expect(result.current.agentStatus).toBe('ready');
    expect(result.current.status).toBe('ready');
  });
});

describe('a mode switch stops nothing', () => {
  it('exposes no stop at all — the one Stop goes through useStopStream to /api/ai/abort', () => {
    const { result } = renderHook(() => useDualModeChat(options(null)));

    // The interface itself is the guarantee. An optional local stop is an invitation, and the
    // two effects that used to consume one are the reason this rule exists.
    expect('stop' in result.current).toBe(false);
    expect('globalStop' in result.current).toBe(false);
    expect('agentStop' in result.current).toBe(false);
  });

  it('given a switch INTO agent mode while global is streaming, does not stop the global run', () => {
    // An effect used to fire `globalStop()` here, documented as an "accepted residual" because
    // "the server generation continues". True, and the half that does not matter: the tokens
    // kept arriving on a channel this tab had stopped reading, so the reply the user came back
    // to was frozen at the moment they glanced away.
    const streamingGlobal = { ...globalSession, status: 'streaming' as const };
    sessionCallCount = 0;
    vi.mocked(useChatSession).mockImplementation((() => {
      sessionCallCount += 1;
      return sessionCallCount % 2 === 1 ? streamingGlobal : agentSession;
    }) as typeof useChatSession);

    const { rerender } = renderHook(
      ({ agent }: { agent: AgentInfo | null }) => useDualModeChat(options(agent)),
      { initialProps: { agent: null as AgentInfo | null } },
    );

    vi.clearAllMocks();
    rerender({ agent: mockAgent });

    // Asserted on the STREAMING mode's own shell: a mode switch must not reach into it at all.
    // (`expect(streamingGlobal.status).toBe('streaming')` stood here, which asserts a literal
    // this test set two lines earlier and could never fail — the same defect CodeRabbit caught
    // in the legacy reader's test. If a future effect fires anything on the mode being switched
    // AWAY from, one of these goes red.)
    for (const [name, fn] of Object.entries(streamingGlobal)) {
      if (typeof fn === 'function' && 'mock' in fn) {
        expect(fn, `a mode switch must not call global.${name}`).not.toHaveBeenCalled();
      }
    }
    // And the agent shell is not driven either — selecting a mode is a view change, not a send.
    expect(agentSession.sendMessage).not.toHaveBeenCalled();
    expect(agentSession.regenerate).not.toHaveBeenCalled();
  });
});
