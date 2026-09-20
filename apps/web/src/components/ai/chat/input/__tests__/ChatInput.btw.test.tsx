import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

// Records the props ChatInput forwards to ChatTextarea so tests can assert
// the client-handled-command capability gate wiring.
const chatTextareaProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock('@/stores/useAssistantSettingsStore', () => ({
  useAssistantSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      webSearchEnabled: false,
      imageGenEnabled: false,
      isAdmin: false,
      writeMode: true,
      showPageTree: false,
      toggleWebSearch: vi.fn(),
      toggleImageGen: vi.fn(),
      toggleWriteMode: vi.fn(),
      toggleShowPageTree: vi.fn(),
      currentProvider: 'anthropic',
      currentModel: 'claude-sonnet-5',
      setProviderSettings: vi.fn(),
      loadSettings: vi.fn(),
    }),
}));

vi.mock('@/hooks/useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({
    isListening: false,
    isSupported: false,
    error: null,
    toggleListening: vi.fn(),
    clearError: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMobileKeyboard', () => ({
  useMobileKeyboard: () => ({ dismiss: vi.fn() }),
}));

vi.mock('../ChatTextarea', () => ({
  ChatTextarea: (props: Record<string, unknown>) => {
    chatTextareaProps.last = props;
    const { value, onSend, disabled } = props as {
      value: string;
      onSend: () => void;
      disabled?: boolean;
    };
    return (
      <textarea
        data-testid="chat-textarea"
        value={value}
        disabled={disabled}
        readOnly
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) onSend();
        }}
      />
    );
  },
}));

vi.mock('../InputActions', () => ({
  InputActions: ({
    onSend,
    disabled,
  }: {
    onSend: () => void;
    disabled?: boolean;
  }) => (
    <button data-testid="input-send" onClick={onSend} disabled={disabled}>
      Send
    </button>
  ),
}));

vi.mock('@/components/ui/floating-input', () => ({
  InputFooter: () => null,
}));

import { ChatInput } from '../ChatInput';

/**
 * The #2678 send-side contract, locked: a `/btw question` line routes to the
 * detached side-question handler instead of the primary send, and stays
 * available while the surface is streaming. Every chat surface that passes
 * `onSideQuestion` depends on this seam — it had no direct tests when only
 * SessionChat was wired.
 */
describe('ChatInput /btw interception', () => {
  const setup = ({
    value,
    isStreaming,
    onSideQuestion,
  }: {
    value: string;
    isStreaming: boolean;
    onSideQuestion?: () => void;
  }) => {
    const onSend = vi.fn();
    const onChange = vi.fn();
    render(
      <ChatInput
        value={value}
        onChange={onChange}
        onSend={onSend}
        onStop={vi.fn()}
        onSideQuestion={onSideQuestion}
        isStreaming={isStreaming}
      />
    );
    return { onSend, onChange };
  };

  const pressEnter = () => {
    fireEvent.keyDown(screen.getByTestId('chat-textarea'), { key: 'Enter' });
  };

  it('routes a /btw line to onSideQuestion, not onSend, while streaming', () => {
    const onSideQuestion = vi.fn();
    const { onSend } = setup({ value: '/btw what changed?', isStreaming: true, onSideQuestion });
    pressEnter();
    expect(onSideQuestion).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('routes a /btw line to onSideQuestion when idle too', () => {
    const onSideQuestion = vi.fn();
    const { onSend } = setup({ value: '/btw why?', isStreaming: false, onSideQuestion });
    pressEnter();
    expect(onSideQuestion).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('without onSideQuestion, a /btw line during streaming sends nothing', () => {
    const { onSend } = setup({ value: '/btw what changed?', isStreaming: true });
    pressEnter();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('without onSideQuestion, a /btw line when idle falls through to the normal send', () => {
    const { onSend } = setup({ value: '/btw what changed?', isStreaming: false });
    pressEnter();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('treats a bare /btw with no question as an ordinary message', () => {
    const onSideQuestion = vi.fn();
    const { onSend } = setup({ value: '/btw', isStreaming: false, onSideQuestion });
    pressEnter();
    expect(onSideQuestion).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('keeps the send button disabled while streaming — Enter is the /btw path', () => {
    setup({ value: '/btw what changed?', isStreaming: true, onSideQuestion: vi.fn() });
    expect((screen.getByTestId('input-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables client-handled command suggestions only when the side-question handler is wired', () => {
    // ChatInput owns the interception gate, so it must open the picker's /btw
    // offer exactly when onSideQuestion is present; ChannelInput-style
    // surfaces (no handler) never see the command in the picker.
    setup({ value: '', isStreaming: false, onSideQuestion: vi.fn() });
    expect(chatTextareaProps.last?.allowClientHandledCommands).toBe(true);
    cleanup();
    setup({ value: '', isStreaming: false });
    expect(chatTextareaProps.last?.allowClientHandledCommands).toBe(false);
  });
});
