import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolsPopover } from '../ToolsPopover';

describe('ToolsPopover', () => {
  it('calls onOpen each time the menu opens, so the trusted-tool list can be re-read', () => {
    const onOpen = vi.fn();
    render(<ToolsPopover toolApprovalMode="ask" onOpen={onOpen} />);
    const trigger = screen.getByRole('button');

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
