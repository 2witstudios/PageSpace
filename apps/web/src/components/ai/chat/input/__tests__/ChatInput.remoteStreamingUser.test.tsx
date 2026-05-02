import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('@/stores/useAssistantSettingsStore', () => ({
  useAssistantSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      webSearchEnabled: false,
      writeMode: false,
      showPageTree: false,
      toggleWebSearch: vi.fn(),
      toggleWriteMode: vi.fn(),
      toggleShowPageTree: vi.fn(),
      currentProvider: 'anthropic',
      currentModel: 'claude-opus-4-7',
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
  ChatTextarea: ({ disabled, value }: { disabled?: boolean; value: string }) => (
    <textarea data-testid="chat-textarea" disabled={disabled} value={value} readOnly />
  ),
}));

vi.mock('../InputActions', () => ({
  InputActions: ({ isStreaming, disabled }: { isStreaming: boolean; disabled: boolean }) => (
    <div
      data-testid="input-actions"
      data-streaming={String(isStreaming)}
      data-disabled={String(disabled)}
    />
  ),
}));

vi.mock('../AttachButton', () => ({
  AttachButton: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="attach-button" data-disabled={String(disabled ?? false)} />
  ),
}));

vi.mock('../AttachmentPreviewStrip', () => ({
  AttachmentPreviewStrip: () => null,
}));

vi.mock('@/components/ui/floating-input', () => ({
  InputFooter: ({ disabled }: { disabled: boolean }) => (
    <div data-testid="input-footer" data-disabled={String(disabled)} />
  ),
}));

import { ChatInput } from '../ChatInput';

const baseProps = {
  value: '',
  onChange: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  isStreaming: false,
};

describe('ChatInput — remoteStreamingUser lock', () => {
  it('given no remoteStreamingUser, the textarea is not forced disabled and no lock banner renders', () => {
    render(<ChatInput {...baseProps} />);

    expect(screen.getByTestId('chat-textarea')).not.toBeDisabled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/is chatting with the AI/)).toBeNull();
  });

  it('given remoteStreamingUser is set, renders the lock banner naming the streamer', () => {
    render(
      <ChatInput
        {...baseProps}
        remoteStreamingUser={{ userId: 'u-alice', displayName: 'Alice' }}
      />
    );

    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Alice is chatting with the AI');
    expect(banner.getAttribute('aria-live')).toBe('polite');
  });

  it('given remoteStreamingUser is set, forces the textarea + footer + attach button into disabled', () => {
    render(
      <ChatInput
        {...baseProps}
        hasVision
        onAddFiles={vi.fn()}
        remoteStreamingUser={{ userId: 'u-alice', displayName: 'Alice' }}
      />
    );

    expect(screen.getByTestId('chat-textarea')).toBeDisabled();
    expect(screen.getByTestId('input-footer').getAttribute('data-disabled')).toBe('true');
    expect(screen.getByTestId('attach-button').getAttribute('data-disabled')).toBe('true');
  });

  it('given remoteStreamingUser is set and isStreaming=false, InputActions stays in send mode (disabled), never the destructive Stop button', () => {
    render(
      <ChatInput
        {...baseProps}
        value="hello"
        remoteStreamingUser={{ userId: 'u-alice', displayName: 'Alice' }}
      />
    );

    const actions = screen.getByTestId('input-actions');
    expect(actions.getAttribute('data-streaming')).toBe('false');
    expect(actions.getAttribute('data-disabled')).toBe('true');
  });

  it('given remoteStreamingUser is null, behaves identically to the prop being omitted', () => {
    const { rerender } = render(<ChatInput {...baseProps} remoteStreamingUser={null} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('chat-textarea')).not.toBeDisabled();

    rerender(<ChatInput {...baseProps} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('chat-textarea')).not.toBeDisabled();
  });
});
