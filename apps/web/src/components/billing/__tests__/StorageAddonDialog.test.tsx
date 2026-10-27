import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StorageAddonDialog, type StorageAddonState } from '../StorageAddonDialog';

const GB = 1024 ** 3;
const addon = (over: Partial<StorageAddonState> = {}): StorageAddonState => ({
  blocks: 0, entitledBlocks: 0, graceUntil: null, currentPeriodEnd: '2026-11-01T00:00:00.000Z',
  blockBytes: 50 * GB, maxBlocks: 20, blockPriceCents: 500, ...over,
});

describe('StorageAddonDialog', () => {
  it('given a first block added, should show the new total and price and submit the new count', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(<StorageAddonDialog open onOpenChange={onOpenChange} addon={addon()} baseQuotaBytes={10 * GB} payerLabel="Your" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add a block' }));
    expect(screen.getByText('60 GB')).toBeTruthy();
    expect(screen.getByText('$5')).toBeTruthy();
    expect(screen.getByText(/Your card is charged now/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add 50 GB' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(1));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('given a decrease, should explain that the paid storage stays until period end', () => {
    render(<StorageAddonDialog open onOpenChange={vi.fn()} addon={addon({ blocks: 2, entitledBlocks: 2 })} baseQuotaBytes={10 * GB} payerLabel="Your" onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a block' }));
    expect(screen.getByText(/You keep the storage you have paid for until/)).toBeTruthy();
    expect(screen.getByText(/no files are deleted/)).toBeTruthy();
  });

  it('given a raise back within storage already paid for this period, should not promise a charge', () => {
    render(<StorageAddonDialog open onOpenChange={vi.fn()} addon={addon({ blocks: 1, entitledBlocks: 3, graceUntil: '2026-11-01T00:00:00.000Z' })} baseQuotaBytes={10 * GB} payerLabel="Your" onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a block' }));
    expect(screen.getByText(/nothing is charged now/)).toBeTruthy();
    expect(screen.queryByText(/card is charged now/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add a block' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a block' }));
    expect(screen.getByText(/Your card is charged now/)).toBeTruthy();
  });

  it('given a refused change, should keep the dialog open and show why', async () => {
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn().mockRejectedValue(new Error('Your card was declined.'));
    render(<StorageAddonDialog open onOpenChange={onOpenChange} addon={addon()} baseQuotaBytes={10 * GB} payerLabel="Your" onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a block' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 50 GB' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Your card was declined.');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
