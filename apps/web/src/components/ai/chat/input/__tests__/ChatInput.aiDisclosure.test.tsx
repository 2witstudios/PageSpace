import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('@/stores/useAssistantSettingsStore', () => ({
  useAssistantSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      webSearchEnabled: false, writeMode: false, showPageTree: false,
      toggleWebSearch: vi.fn(), toggleWriteMode: vi.fn(), toggleShowPageTree: vi.fn(),
      currentProvider: 'anthropic', currentModel: 'claude-opus-4-7',
      setProviderSettings: vi.fn(), loadSettings: vi.fn(),
    }),
}));
vi.mock('@/hooks/useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({ isListening: false, isSupported: false, error: null, toggleListening: vi.fn(), clearError: vi.fn() }),
}));
vi.mock('@/hooks/useMobileKeyboard', () => ({ useMobileKeyboard: () => ({ dismiss: vi.fn() }) }));
vi.mock('../ChatTextarea', () => ({ ChatTextarea: () => <textarea data-testid="chat-textarea" readOnly /> }));
vi.mock('../InputActions', () => ({
  InputActions: ({ onSend }: { onSend: () => void }) => <button type="button" onClick={onSend}>Send</button>,
}));
vi.mock('../AttachButton', () => ({ AttachButton: () => null }));
vi.mock('../AttachmentPreviewStrip', () => ({ AttachmentPreviewStrip: () => null }));
vi.mock('@/components/ui/floating-input', () => ({ InputFooter: () => null }));
vi.mock('@/components/ui/alert-dialog', () => {
  type P = { children?: React.ReactNode; open?: boolean };
  const Pass = ({ children }: P) => <div>{children}</div>;
  return {
    AlertDialog: ({ open, children }: P) => (open ? <div role="alertdialog">{children}</div> : null),
    AlertDialogContent: Pass, AlertDialogHeader: Pass, AlertDialogTitle: Pass, AlertDialogDescription: Pass, AlertDialogFooter: Pass,
    AlertDialogCancel: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => <button type="button" onClick={onClick}>{children}</button>,
  };
});
const { isCapacitorApp } = vi.hoisted(() => ({ isCapacitorApp: vi.fn(() => false) }));
vi.mock('@/lib/capacitor-bridge', () => ({ isCapacitorApp }));

import { ChatInput } from '../ChatInput';
import { AI_DISCLOSURE_STORAGE_KEY } from '@/lib/ai/ai-disclosure';

const props = () => ({ value: 'hello', onChange: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), isStreaming: false });

describe('ChatInput — third-party AI disclosure', () => {
  beforeEach(() => {
    window.localStorage.removeItem(AI_DISCLOSURE_STORAGE_KEY);
    isCapacitorApp.mockReturnValue(false);
  });

  it('given the native app and a first message, should ask before anything is sent', () => {
    isCapacitorApp.mockReturnValue(true);
    const p = props();
    render(<ChatInput {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(p.onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog').textContent).toMatch(/third-party AI provider/i);
  });

  it('given the user agrees, should send the message and not ask again', () => {
    isCapacitorApp.mockReturnValue(true);
    const p = props();
    render(<ChatInput {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agree and continue' }));
    expect(p.onSend).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(p.onSend).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('given the user declines, should send nothing', () => {
    isCapacitorApp.mockReturnValue(true);
    const p = props();
    render(<ChatInput {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it('given the web, should send without asking', () => {
    const p = props();
    render(<ChatInput {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(p.onSend).toHaveBeenCalledTimes(1);
  });
});
