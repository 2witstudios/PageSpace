import { describe, it, expect, vi } from 'vitest';
import { syncedEventVisibility } from '../sync-visibility';

describe('syncedEventVisibility', () => {
  it('SEAT-9 (partial) [D-OW-33] ruling: a Google sync that would make an org-drive event more visible keeps the current visibility while the org is lapsed; paid, it takes Google\'s', async () => {
    const lapsed = vi.fn(async () => true);
    expect(await syncedEventVisibility({ driveId: 'd1', visibility: 'PRIVATE' }, 'DRIVE', lapsed)).toBe('PRIVATE');
    expect(lapsed).toHaveBeenCalledWith('d1');
    const paid = vi.fn(async () => false);
    expect(await syncedEventVisibility({ driveId: 'd1', visibility: 'PRIVATE' }, 'DRIVE', paid)).toBe('DRIVE');
  });

  it('SEAT-9 (partial) [D-OW-33] ruling: a narrowing, an unchanged value, a personal event or no value from Google never asks the lapse', async () => {
    const ask = vi.fn(async () => true);
    expect(await syncedEventVisibility({ driveId: 'd1', visibility: 'DRIVE' }, 'PRIVATE', ask)).toBe('PRIVATE');
    expect(await syncedEventVisibility({ driveId: 'd1', visibility: 'DRIVE' }, 'DRIVE', ask)).toBe('DRIVE');
    expect(await syncedEventVisibility({ driveId: null, visibility: 'PRIVATE' }, 'DRIVE', ask)).toBe('DRIVE');
    expect(await syncedEventVisibility(undefined, 'DRIVE', ask)).toBe('DRIVE');
    expect(await syncedEventVisibility({ driveId: 'd1', visibility: 'PRIVATE' }, undefined, ask)).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });
});
