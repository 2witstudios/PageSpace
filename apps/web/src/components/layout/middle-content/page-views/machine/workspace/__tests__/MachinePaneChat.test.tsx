/**
 * MachinePaneChat Component Tests — Phase 11 (#2166)
 *
 * The behavior contract lives in useMachinePaneChat.test.ts; this suite
 * covers the component shell: in-pane tabs, the share-control-free History
 * tab, per-mode Settings, and the composer wiring. The state hook is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentInfo } from '@/types/agent';

const paneState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock('../useMachinePaneChat', () => ({
  useMachinePaneChat: vi.fn(() => paneState.current),
}));

// Presentation-only children with heavy dependency trees are stubbed — this
// suite is about MachinePaneChat's own shell, not theirs.
vi.mock('@/components/layout/right-sidebar/ai-assistant/SidebarChatTab', () => ({
  SidebarMessagesContent: () => <div data-testid="messages-content" />,
}));

vi.mock('@/components/ai/chat/input', () => ({
  ChatInput: ({ value, onChange, onSend }: {
    value: string;
    onChange: (v: string) => void;
    onSend: () => void;
  }) => (
    <div>
      <input
        data-testid="chat-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button data-testid="chat-send" onClick={onSend}>
        Send
      </button>
    </div>
  ),
}));

vi.mock('@/components/ai/chat/input/ProviderModelSelector', () => ({
  ProviderModelSelector: () => <div data-testid="provider-model-selector" />,
}));

vi.mock('@/components/ai/shared', () => ({
  AISelector: ({ onSelectAgent }: { onSelectAgent: (agent: AgentInfo | null) => void }) => (
    <button data-testid="agent-picker" onClick={() => onSelectAgent(null)}>
      Picker
    </button>
  ),
}));

vi.mock('@/components/ai/shared/chat', () => ({
  UndoAiChangesDialog: () => null,
}));

// jsdom lacks the pointer-capture APIs and scrollIntoView Radix's DropdownMenu
// uses when opening — without these stubs, clicking the overflow trigger
// throws instead of rendering its items (same stubs as TerminalPanes.test).
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

import MachinePaneChat from '../MachinePaneChat';

function conversationRow(id: string, title: string) {
  const now = new Date();
  return {
    id,
    title,
    preview: 'preview',
    isShared: false,
    isOwner: true,
    createdAt: now,
    updatedAt: now,
    messageCount: 1,
    lastMessage: { role: 'user', timestamp: now },
  };
}

function basePaneState(overrides: Record<string, unknown> = {}) {
  return {
    selectedAgent: null,
    selectAgent: vi.fn(),
    currentConversationId: 'terminal-1',
    channelId: 'machine-1',
    messages: [],
    remoteStreams: [],
    displayIsStreaming: false,
    isMessagesLoading: false,
    hasLoadError: false,
    reloadConversation: vi.fn(),
    handleSend: vi.fn(async () => true),
    handleStop: vi.fn(async () => {}),
    handleEdit: vi.fn(),
    handleDelete: vi.fn(),
    handleRetry: vi.fn(),
    lastAssistantMessageId: undefined,
    lastUserMessageId: undefined,
    handleScrollNearTop: vi.fn(),
    isLoadingOlder: false,
    hasMoreOlder: false,
    conversations: [],
    isLoadingConversations: false,
    openConversation: vi.fn(async () => {}),
    createNewConversation: vi.fn(async () => 'new-conv'),
    deleteConversation: vi.fn(async () => {}),
    errorCause: null,
    dismissError: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  paneState.current = basePaneState();
});

describe('MachinePaneChat', () => {
  it('renders the chat tab by default and dispatches sends through the hook', async () => {
    render(<MachinePaneChat machineId="machine-1" terminalId="terminal-1" />);

    expect(screen.getByTestId('machine-pane-chat')).toBeInTheDocument();
    expect(screen.getByTestId('messages-content')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() =>
      expect(paneState.current.handleSend).toHaveBeenCalledWith('hello'),
    );
  });

  it('History tab lists conversations WITHOUT share controls and opens into the chat tab', async () => {
    paneState.current = basePaneState({
      conversations: [conversationRow('conv-1', 'Machine chat')],
    });

    render(<MachinePaneChat machineId="machine-1" terminalId="terminal-1" />);

    await userEvent.click(screen.getByRole('tab', { name: 'History' }));

    const row = await screen.findByTestId('history-conversation-item');
    expect(row).toHaveTextContent('Machine chat');
    // Minus share: PageAgentHistoryTab renders its share toggle only when
    // onToggleShare is passed — this surface never passes it.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByTitle(/share/i)).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(paneState.current.openConversation).toHaveBeenCalledWith('conv-1');
    await waitFor(() =>
      expect(screen.getByTestId('messages-content')).toBeInTheDocument(),
    );
  });

  it('Settings tab shows slim assistant settings in default mode', async () => {
    render(<MachinePaneChat machineId="machine-1" terminalId="terminal-1" />);

    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    expect(screen.getByTestId('machine-pane-assistant-settings')).toBeInTheDocument();
    expect(screen.getByTestId('provider-model-selector')).toBeInTheDocument();
  });

  it('Settings tab shows the agent\'s read-only configuration in agent mode', async () => {
    paneState.current = basePaneState({
      selectedAgent: {
        id: 'agent-1',
        title: 'Docs Agent',
        driveId: 'drive-1',
        driveName: 'Docs Drive',
        aiProvider: 'anthropic',
        aiModel: 'claude-sonnet-5',
      } satisfies AgentInfo,
      currentConversationId: 'conv-agent',
      channelId: 'agent-1',
    });

    render(<MachinePaneChat machineId="machine-1" terminalId="terminal-1" />);

    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    const settings = screen.getByTestId('machine-pane-agent-settings');
    expect(settings).toHaveTextContent('Docs Agent');
    expect(settings).toHaveTextContent('anthropic');
    expect(settings).toHaveTextContent('claude-sonnet-5');
  });

  it('shows the load-error banner with a retry wired to reloadConversation', () => {
    paneState.current = basePaneState({ hasLoadError: true });

    render(<MachinePaneChat machineId="machine-1" terminalId="terminal-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(paneState.current.reloadConversation).toHaveBeenCalled();
  });
});

describe('MachinePaneChat (pane bar)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paneState.current = basePaneState();
  });

  const controls = () => ({
    canSplit: true,
    canClose: true,
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onClose: vi.fn(),
  });

  it('renders the pane controls in its ONE bar, tinted when the pane is active', async () => {
    const paneControls = controls();
    render(
      <MachinePaneChat machineId="machine-1" terminalId="terminal-1" isActive paneControls={paneControls} />,
    );

    const bar = screen.getByTestId('pane-bar');
    expect(bar.getAttribute('data-active')).toBe('true');
    // The controls live IN the bar — nothing floats over the tabs anymore.
    expect(screen.getByTitle('Split right')).toBeInTheDocument();
    expect(screen.getByTitle('Close pane')).toBeInTheDocument();

    await userEvent.click(screen.getByTitle('Close pane'));
    expect(paneControls.onClose).toHaveBeenCalledTimes(1);
  });

  it('without paneControls (or focus), the bar is plain and control-free', () => {
    render(<MachinePaneChat machineId="machine-1" terminalId="terminal-1" />);

    expect(screen.getByTestId('pane-bar').getAttribute('data-active')).toBeNull();
    expect(screen.queryByTitle('Close pane')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Split right')).not.toBeInTheDocument();
  });

  it('the overflow menu lists the folded actions — INCLUDING Chat — and drives them', async () => {
    const paneControls = controls();
    render(
      <MachinePaneChat machineId="machine-1" terminalId="terminal-1" isActive paneControls={paneControls} />,
    );

    await userEvent.click(screen.getByTitle('More'));

    // Everything foldable is here. Chat matters most: below the fold width the
    // TabsList is hidden, so this menu is the ONLY way back to the
    // conversation after opening History or Settings. Close is NOT here — it
    // never leaves the bar.
    expect(await screen.findByRole('menuitem', { name: /Chat/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /New conversation/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /History/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Settings/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Split down/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Close/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('menuitem', { name: /Split right/ }));
    expect(paneControls.onSplitRight).toHaveBeenCalledTimes(1);
  });

  it('overflow-menu Chat returns to the conversation from another tab', async () => {
    render(<MachinePaneChat machineId="machine-1" terminalId="terminal-1" paneControls={controls()} />);

    // Leave the chat tab first (Settings), then come back via the menu alone —
    // the narrow-pane path where the TabsList is unavailable.
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByTestId('machine-pane-assistant-settings')).toBeInTheDocument();

    await userEvent.click(screen.getByTitle('More'));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Chat/ }));

    expect(await screen.findByTestId('messages-content')).toBeInTheDocument();
  });

  it('overflow-menu clicks do not bubble into the pane\'s own click handler', async () => {
    // The menu is portaled, but React portals bubble through the REACT tree —
    // straight into TerminalPane's onClick={onSelect}. A split action that
    // re-selects the SOURCE pane undoes the new pane's activation.
    const onPaneClick = vi.fn();
    const paneControls = controls();
    render(
      <div onClick={onPaneClick}>
        <MachinePaneChat machineId="machine-1" terminalId="terminal-1" paneControls={paneControls} />
      </div>,
    );

    await userEvent.click(screen.getByTitle('More'));
    onPaneClick.mockClear(); // opening the menu may bubble; only the ACTION must not
    await userEvent.click(await screen.findByRole('menuitem', { name: /Split right/ }));

    expect(paneControls.onSplitRight).toHaveBeenCalledTimes(1);
    expect(onPaneClick).not.toHaveBeenCalled();
  });

  it('selecting History from the overflow menu switches to the history tab', async () => {
    paneState.current = basePaneState({
      conversations: [conversationRow('conv-1', 'Machine chat')],
    });
    render(
      <MachinePaneChat machineId="machine-1" terminalId="terminal-1" paneControls={controls()} />,
    );

    await userEvent.click(screen.getByTitle('More'));
    await userEvent.click(await screen.findByRole('menuitem', { name: /History/ }));

    expect(await screen.findByTestId('history-conversation-item')).toHaveTextContent('Machine chat');
  });
});
