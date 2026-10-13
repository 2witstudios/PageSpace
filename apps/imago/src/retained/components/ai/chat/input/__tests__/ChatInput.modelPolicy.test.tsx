// @vitest-environment jsdom
import '@/retained/test/setup';
import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('@/retained/stores/useAssistantSettingsStore', () => ({
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

vi.mock('@/retained/hooks/useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({
    isListening: false,
    isSupported: false,
    error: null,
    toggleListening: vi.fn(),
    clearError: vi.fn(),
  }),
}));

vi.mock('@/retained/hooks/useMobileKeyboard', () => ({
  useMobileKeyboard: () => ({ dismiss: vi.fn() }),
}));

/**
 * ChatTextarea is mocked because driving its real slash-command parser is out
 * of scope here — what this suite needs is a composer that can (a) call
 * onSend the way Enter does, (b) optionally swallow Escape on the capture
 * phase the way suggestion/mention pickers do.
 */
let preventNextEscape = false;

vi.mock('../ChatTextarea', () => ({
  ChatTextarea: ({
    disabled,
    value,
    onSend,
  }: {
    disabled?: boolean;
    value: string;
    onSend?: () => void;
  }) => (
    <div>
      <textarea
        data-testid="chat-textarea"
        disabled={disabled}
        value={value}
        readOnly
        onKeyDownCapture={(e) => {
          if (preventNextEscape) e.preventDefault();
        }}
      />
      <button type="button" data-testid="mock-enter" onClick={() => onSend?.()}>
        enter
      </button>
    </div>
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

vi.mock('@/retained/components/ui/floating-input', () => ({
  InputFooter: ({ disabled, modelPolicyDriveId }: { disabled: boolean; modelPolicyDriveId?: string | null }) => (
    <div data-testid="input-footer" data-drive={modelPolicyDriveId} data-disabled={String(disabled)} />
  ),
}));

// InputActions and QueueTray are deliberately REAL: the queue affordance and
// the tray are the feature.

import { ChatInput } from '../ChatInput';

const baseProps = {
  value: '',
  onChange: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  isStreaming: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  preventNextEscape = false;
});

it('model policy uses the agent command drive rather than the mention drive', () => {
  render(<ChatInput {...baseProps} driveId="d-route" commandDriveId="d-agent" />);
  expect(screen.getByTestId('input-footer').getAttribute('data-drive')).toBe('d-agent');
});
it('model policy defaults to the supplied drive', () => {
  render(<ChatInput {...baseProps} driveId="d-current" />);
  expect(screen.getByTestId('input-footer').getAttribute('data-drive')).toBe('d-current');
});
