/**
 * The composer's command-picker drive scope.
 *
 * `useCommandSuggestion` turns whatever `driveId` it is handed into the
 * `/api/commands/suggest?driveId=` query, and with none the route skips the
 * drive-commands query outright — so an unscoped composer can only ever offer
 * built-ins plus personal commands. This suite guards the wiring that decides
 * that scope, which the surface-level suites cannot: they mock `ChatInput`
 * away, so removing `commandDriveId ?? driveId` here leaves them green.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

const captured = vi.hoisted(() => ({
  command: undefined as { driveId?: string } | undefined,
  mention: undefined as { driveId?: string; crossDrive?: boolean } | undefined,
}));

vi.mock('@/hooks/useCommandSuggestion', () => ({
  useCommandSuggestion: (props: { driveId?: string }) => {
    captured.command = props;
    return {
      isOpen: false,
      position: null,
      items: [],
      hasAnyCommands: false,
      loading: false,
      loadFailed: false,
      query: '',
      selectedIndex: 0,
      handleInput: vi.fn(),
      handleKeyDown: vi.fn(),
      handleCompositionStart: vi.fn(),
      handleCompositionEnd: vi.fn(),
      syncDisplayText: vi.fn(),
      actions: {
        select: vi.fn(),
        setSelectedIndex: vi.fn(),
        close: vi.fn(),
        dismiss: vi.fn(),
      },
    };
  },
}));

vi.mock('@/hooks/useSuggestion', () => ({
  useSuggestion: (props: { driveId?: string; crossDrive?: boolean }) => {
    captured.mention = props;
    return {
      query: '',
      handleKeyDown: vi.fn(),
      handleValueChange: vi.fn(),
      actions: { selectSuggestion: vi.fn(), close: vi.fn() },
    };
  },
}));

vi.mock('@/components/mentions/MentionPickerPortal', () => ({
  MentionPickerPortal: () => null,
}));

vi.mock('@/components/commands/CommandPickerPortal', () => ({
  CommandPickerPortal: () => null,
}));

import { ChatTextarea } from '../ChatTextarea';

const baseProps = {
  value: '',
  onChange: vi.fn(),
  onSend: vi.fn(),
};

beforeEach(() => {
  captured.command = undefined;
  captured.mention = undefined;
});

describe('ChatTextarea — command picker drive scope', () => {
  it('scopes the command picker to commandDriveId when it differs from the mention drive', () => {
    render(<ChatTextarea {...baseProps} driveId="route-drive" commandDriveId="agent-drive" />);
    expect(captured.command?.driveId).toBe('agent-drive');
  });

  it('leaves mention search on its own driveId — command scope must not move it', () => {
    render(
      <ChatTextarea
        {...baseProps}
        driveId="route-drive"
        commandDriveId="agent-drive"
        crossDrive
      />
    );
    expect(captured.mention?.driveId).toBe('route-drive');
    expect(captured.mention?.crossDrive).toBe(true);
  });

  it('falls back to driveId when commandDriveId is omitted, so existing callers are unchanged', () => {
    render(<ChatTextarea {...baseProps} driveId="route-drive" />);
    expect(captured.command?.driveId).toBe('route-drive');
  });

  it('passes undefined when neither is given, which the suggest route reads as "no drive"', () => {
    render(<ChatTextarea {...baseProps} />);
    expect(captured.command?.driveId).toBeUndefined();
  });
});
