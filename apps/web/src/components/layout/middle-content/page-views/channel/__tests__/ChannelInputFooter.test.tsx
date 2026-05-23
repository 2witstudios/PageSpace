import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import type { MentionSuggestion } from '@/types/mentions';

// Stub MentionPickerPopover — we test ChannelInputFooter's wiring, not the picker internals
const { mockPickerOpen } = vi.hoisted(() => ({ mockPickerOpen: vi.fn() }));
vi.mock('@/components/mentions/MentionPicker', () => ({
  MentionPickerPopover: ({
    children,
    onMentionSelect,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onMentionSelect: (s: MentionSuggestion) => void;
    open?: boolean;
    onOpenChange?: (v: boolean) => void;
  }) => {
    mockPickerOpen(open);
    return (
      <div>
        <div onClick={() => onOpenChange?.(!open)}>{children}</div>
        {open && (
          <div data-testid="mention-picker-popover">
            <button
              data-testid="pick-alice"
              onClick={() =>
                onMentionSelect({
                  id: 'user-1',
                  label: 'Alice',
                  type: 'user',
                  data: {},
                })
              }
            >
              Alice
            </button>
          </div>
        )}
      </div>
    );
  },
}));

import { ChannelInputFooter } from '../ChannelInputFooter';

describe('ChannelInputFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mention button', () => {
    it('should render the mention button', () => {
      render(
        <ChannelInputFooter
          onMentionSelect={vi.fn()}
          driveId="drive-1"
        />,
      );
      expect(screen.getByRole('button', { name: /mention/i })).toBeInTheDocument();
    });

    it('should open the MentionPickerPopover when the mention button is clicked', async () => {
      const user = userEvent.setup();
      render(
        <ChannelInputFooter
          onMentionSelect={vi.fn()}
          driveId="drive-1"
        />,
      );

      await user.click(screen.getByRole('button', { name: /mention/i }));

      expect(screen.getByTestId('mention-picker-popover')).toBeInTheDocument();
    });

    it('should call onMentionSelect with the chosen suggestion', async () => {
      const onMentionSelect = vi.fn();
      const user = userEvent.setup();
      render(
        <ChannelInputFooter
          onMentionSelect={onMentionSelect}
          driveId="drive-1"
        />,
      );

      await user.click(screen.getByRole('button', { name: /mention/i }));
      await user.click(screen.getByTestId('pick-alice'));

      expect(onMentionSelect).toHaveBeenCalledWith({
        id: 'user-1',
        label: 'Alice',
        type: 'user',
        data: {},
      });
    });
  });
});
