/**
 * SessionChat Component Tests — Phase 6.
 *
 * The state hook is mocked; this suite covers the component shell: the
 * context switch (full MessageRenderer via ChatMessagesArea in 'page',
 * CompactMessageRenderer via SidebarMessagesContent in 'console'), the
 * composer wiring (clear-on-send, restore-draft-on-refusal), the loading/error
 * states, and read-only gating.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentInfo } from '@/types/agent';
import { useAskUserAnswerContext } from '@/components/ai/shared/chat/ask-user/AskUserAnswerContext';

const chatState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock('../useAgentSessionChat', () => ({
  useAgentSessionChat: vi.fn(() => chatState.current),
}));

vi.mock('@/components/ai/shared/chat/ChatMessagesArea', () => ({
  ChatMessagesArea: () => {
    const ctx = useAskUserAnswerContext();
    return <div data-testid="chat-messages-area" data-ask-user-ctx={ctx ? 'present' : 'absent'} />;
  },
}));

vi.mock('@/components/layout/right-sidebar/ai-assistant/SidebarChatTab', () => ({
  SidebarMessagesContent: () => <div data-testid="sidebar-messages-content" />,
}));

vi.mock('@/components/ai/chat/input', () => ({
  ChatInput: ({
    value,
    onChange,
    onSend,
    disabled,
    placeholder,
    commandDriveId,
  }: {
    value: string;
    onChange: (v: string) => void;
    onSend: () => void;
    disabled?: boolean;
    placeholder?: string;
    commandDriveId?: string;
  }) => (
    <div>
      <input
        data-testid="chat-input"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        data-command-drive-id={commandDriveId ?? 'none'}
        onChange={(e) => onChange(e.target.value)}
      />
      <button data-testid="chat-send" onClick={onSend}>
        Send
      </button>
    </div>
  ),
}));

vi.mock('@/components/ai/shared/chat', () => ({
  UndoAiChangesDialog: () => null,
}));

const assistantChatState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock('../useAssistantSessionChat', () => ({
  useAssistantSessionChat: vi.fn(() => assistantChatState.current),
  // The session's own drive when it has one, else whatever the pathname
  // resolves to — the same fallback the real hook feeds into `contextRef`.
  useAssistantContextRef: vi.fn((driveId: string | null) => ({
    routeType: 'drive',
    driveId: driveId ?? 'drive-from-pathname',
  })),
}));

vi.mock('@/stores/useAssistantSettingsStore', () => ({
  useAssistantSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ currentModel: 'claude-sonnet-5' }),
}));

vi.mock('@/components/ai/shared/chat/ChatErrorBanner', () => ({
  ChatErrorBanner: ({ cause }: { cause: unknown }) =>
    cause ? <div data-testid="chat-error-banner" /> : null,
}));

import SessionChat from '../SessionChat';
import AssistantSessionChat from '../AssistantSessionChat';

function agentFixture(): AgentInfo {
  return {
    id: 'agent-1',
    title: 'My Agent',
    driveId: 'drive-1',
    driveName: 'Drive One',
    aiProvider: 'anthropic',
    aiModel: 'claude-sonnet-5',
  };
}

function baseChatState(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    remoteStreams: [],
    displayIsStreaming: false,
    isMessagesLoading: false,
    hasLoadError: false,
    reloadConversation: vi.fn(async () => {}),
    handleSend: vi.fn(async () => true),
    handleStop: vi.fn(async () => {}),
    handleEdit: vi.fn(async () => {}),
    handleDelete: vi.fn(async () => {}),
    handleRetry: vi.fn(async () => {}),
    lastAssistantMessageId: undefined,
    lastUserMessageId: undefined,
    handleScrollNearTop: vi.fn(),
    isLoadingOlder: false,
    hasMoreOlder: false,
    errorCause: null,
    dismissError: vi.fn(),
    askUserAnswering: { answerableToolCallIds: new Set<string>(), submitAnswers: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  chatState.current = baseChatState();
  assistantChatState.current = baseChatState();
});

describe('SessionChat', () => {
  // Regression: the composer rendered with no command drive at all, so `/`
  // listed only built-ins + personal commands — `loadAvailableCommands` skips
  // the drive query entirely when driveId is null, and a command the picker
  // never offers can never be inserted as a chip, which is the only way one
  // executes. The scope MUST be the agent page's own drive, because that is
  // what the server resolves chips against (page-chat-turn's `page.driveId`);
  // a session's drive can legitimately differ and would offer commands that
  // then fail as not_found.
  it("scopes the command picker to the agent's drive", () => {
    render(<SessionChat agent={agentFixture()} conversationId="conv-1" context="page" />);
    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'data-command-drive-id',
      'drive-1'
    );
  });

  it("renders the full messages area (ChatMessagesArea) in 'page' context", () => {
    render(<SessionChat agent={agentFixture()} conversationId="conv-1" context="page" />);
    expect(screen.getByTestId('chat-messages-area')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-messages-content')).not.toBeInTheDocument();
  });

  it("renders the compact messages area (SidebarMessagesContent) in 'console' context", () => {
    render(<SessionChat agent={agentFixture()} conversationId="conv-1" context="console" />);
    expect(screen.getByTestId('sidebar-messages-content')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-messages-area')).not.toBeInTheDocument();
  });

  it('shows a loading spinner when messages are loading and nothing is cached yet', () => {
    chatState.current = baseChatState({ isMessagesLoading: true });
    render(<SessionChat agent={agentFixture()} conversationId="conv-1" context="page" />);
    expect(screen.getByTestId('session-chat-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-messages-area')).not.toBeInTheDocument();
  });

  it('shows the load-error banner with a retry action that calls reloadConversation', () => {
    const reloadConversation = vi.fn(async () => {});
    chatState.current = baseChatState({ hasLoadError: true, reloadConversation });
    render(<SessionChat agent={agentFixture()} conversationId="conv-1" context="page" />);
    fireEvent.click(screen.getByText('Retry'));
    expect(reloadConversation).toHaveBeenCalled();
  });

  it('clears the composer immediately on send, and dispatches through handleSend', async () => {
    const handleSend = vi.fn(async () => true);
    chatState.current = baseChatState({ handleSend });
    render(<SessionChat agent={agentFixture()} conversationId="conv-1" context="page" />);

    const input = screen.getByTestId('chat-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    expect(input.value).toBe('');
    await waitFor(() => expect(handleSend).toHaveBeenCalledWith('hello'));
  });

  it('restores the draft when handleSend refuses (returns false) and the composer is still empty', async () => {
    const handleSend = vi.fn(async () => false);
    chatState.current = baseChatState({ handleSend });
    render(<SessionChat agent={agentFixture()} conversationId="conv-1" context="page" />);

    const input = screen.getByTestId('chat-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(input.value).toBe('hello'));
  });

  it('disables the composer and shows "View only" in read-only mode', () => {
    render(
      <SessionChat agent={agentFixture()} conversationId="conv-1" context="page" isReadOnly />,
    );
    const input = screen.getByTestId('chat-input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('View only');
  });

  it('provides ask_user answering context to the message renderer when not read-only', () => {
    render(<SessionChat agent={agentFixture()} conversationId="conv-1" context="page" />);
    expect(screen.getByTestId('chat-messages-area')).toHaveAttribute('data-ask-user-ctx', 'present');
  });

  // The bug this covers (Codex P2, PR #2303): the provider ignored `isReadOnly`, so a
  // viewer without edit permission could still submit ask_user answers — enabling
  // options/Submit that would 403 (or actually resume a global-assistant pane) despite
  // the surface showing "View only".
  it('withholds ask_user answering context from the message renderer in read-only mode', () => {
    render(
      <SessionChat agent={agentFixture()} conversationId="conv-1" context="page" isReadOnly />,
    );
    expect(screen.getByTestId('chat-messages-area')).toHaveAttribute('data-ask-user-ctx', 'absent');
  });

  it('shows the error banner when an error cause is present', () => {
    chatState.current = baseChatState({ errorCause: { message: 'boom' } });
    render(<SessionChat agent={agentFixture()} conversationId="conv-1" context="page" />);
    expect(screen.getByTestId('chat-error-banner')).toBeInTheDocument();
  });
});

describe('AssistantSessionChat — command picker scope', () => {
  // The global assistant's execution scope is not its `driveId` prop but the
  // contextRef it ships, which `global-chat-turn` resolves into the drive it
  // scopes commands to. Routing the picker through the SAME ref is what keeps
  // the two from disagreeing.
  it("uses the session's own drive when it has one", () => {
    render(
      <AssistantSessionChat
        sessionId="sess-1"
        conversationId="conv-1"
        driveId="drive-2"
        context="page"
      />
    );
    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'data-command-drive-id',
      'drive-2'
    );
  });

  it('falls back to the pathname-derived drive for a driveless session, rather than dropping drive commands the server would have run', () => {
    render(
      <AssistantSessionChat
        sessionId="sess-1"
        conversationId="conv-1"
        driveId={null}
        context="page"
      />
    );
    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'data-command-drive-id',
      'drive-from-pathname'
    );
  });
});
