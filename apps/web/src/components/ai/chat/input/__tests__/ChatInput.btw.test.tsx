import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

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
  ChatTextarea: ({
    value,
    onSend,
    disabled,
  }: {
    value: string;
    onSend: () => void;
    disabled?: boolean;
  }) => (
    <textarea
      data-testid="chat-textarea"
      value={value}
      disabled={disabled}
      readOnly
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) onSend();
      }}
    />
  ),
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
});
