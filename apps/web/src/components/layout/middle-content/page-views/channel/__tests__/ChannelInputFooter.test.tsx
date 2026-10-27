import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import type { MentionSuggestion } from '@/types/mentions';

// Stub MentionPicker — we test ChannelInputFooter's wiring, not the picker internals
vi.mock('@/components/mentions/MentionPicker', () => ({
  MentionPicker: ({
    onMentionSelect,
  }: {
    onMentionSelect: (s: MentionSuggestion) => void;
    driveId?: string;
    crossDrive?: boolean;
    allowedTypes?: string[];
  }) => (
    <div data-testid="mention-picker">
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
  ),
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

    it('should open the MentionPicker when the mention button is clicked', async () => {
      const user = userEvent.setup();
      render(
        <ChannelInputFooter
          onMentionSelect={vi.fn()}
          driveId="drive-1"
        />,
      );

      await user.click(screen.getByRole('button', { name: /mention/i }));

      expect(screen.getByTestId('mention-picker')).toBeInTheDocument();
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
