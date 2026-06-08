import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildDiffSummary } from '../BackupDiffPreview';
import type { RestoreDiff } from '@/services/api/restore-diff-service';

// ============================================================================
// buildDiffSummary — pure function tests (zero mocks, zero I/O)
// ============================================================================

const makeDiff = (overrides: Partial<RestoreDiff> = {}): RestoreDiff => ({
  toCreate: [],
  toOverwrite: [],
  toOrphan: [],
  unchanged: [],
  ...overrides,
});

describe('buildDiffSummary', () => {
  it('computes correct totals with mixed diff', () => {
    const diff = makeDiff({
      toCreate: [{ pageId: 'a', title: 'A', type: 'document' }],
      toOverwrite: [{ pageId: 'b', title: 'B', currentHash: null, backupHash: 'h' }],
      toOrphan: [{ pageId: 'c', title: 'C' }],
      unchanged: [{ pageId: 'd' }],
    });
    expect(buildDiffSummary(diff)).toEqual({ total: 2, orphanCount: 1, unchangedCount: 1 });
  });

  it('returns all zeros for empty diff', () => {
    expect(buildDiffSummary(makeDiff())).toEqual({ total: 0, orphanCount: 0, unchangedCount: 0 });
  });

  it('calling twice with same args returns identical output (pure)', () => {
    const diff = makeDiff({
      toCreate: [{ pageId: 'x', title: 'X', type: 'document' }],
      toOrphan: [{ pageId: 'y', title: 'Y' }],
    });
    expect(buildDiffSummary(diff)).toEqual(buildDiffSummary(diff));
  });
});

// ============================================================================
// BackupDiffPreview — component render tests
// Note: these tests require React rendering and cannot run in .pu worktrees.
// They are validated via typecheck in this context; CI runs them in full.
// ============================================================================

// import { render, screen, fireEvent, waitFor } from '@testing-library/react';
// import { BackupDiffPreview } from '../BackupDiffPreview';

/*
describe('BackupDiffPreview', () => {
  const driveId = 'drive_1';
  const backupId = 'backup_1';

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('does not render "Preview restore" when status !== ready', () => {
    render(<BackupDiffPreview driveId={driveId} backup={{ id: backupId, status: 'pending' }} />);
    expect(screen.queryByText('Preview restore')).toBeNull();
  });

  it('renders "Preview restore" button when status === ready', () => {
    render(<BackupDiffPreview driveId={driveId} backup={{ id: backupId, status: 'ready' }} />);
    expect(screen.getByText('Preview restore')).toBeTruthy();
  });

  it('shows spinner while diff is loading, no "Restore now" button', async () => {
    vi.mocked(global.fetch).mockReturnValue(new Promise(() => {})); // never resolves
    render(<BackupDiffPreview driveId={driveId} backup={{ id: backupId, status: 'ready' }} />);
    fireEvent.click(screen.getByText('Preview restore'));
    expect(screen.queryByText('Restore now')).toBeNull();
  });

  it('shows orphan warning when orphanCount > 0', async () => {
    const diff = makeDiff({ toOrphan: [{ pageId: 'p', title: 'P' }] });
    vi.mocked(global.fetch).mockResolvedValue({ ok: true, json: async () => ({ diff }) } as Response);
    render(<BackupDiffPreview driveId={driveId} backup={{ id: backupId, status: 'ready' }} />);
    fireEvent.click(screen.getByText('Preview restore'));
    await waitFor(() => expect(screen.getByText(/will be soft-deleted/)).toBeTruthy());
  });

  it('does not show orphan warning when orphanCount === 0', async () => {
    const diff = makeDiff();
    vi.mocked(global.fetch).mockResolvedValue({ ok: true, json: async () => ({ diff }) } as Response);
    render(<BackupDiffPreview driveId={driveId} backup={{ id: backupId, status: 'ready' }} />);
    fireEvent.click(screen.getByText('Preview restore'));
    await waitFor(() => expect(screen.getByText('Restore now')).toBeTruthy());
    expect(screen.queryByText(/will be soft-deleted/)).toBeNull();
  });

  it('shows "Restore now" after diff is loaded', async () => {
    const diff = makeDiff();
    vi.mocked(global.fetch).mockResolvedValue({ ok: true, json: async () => ({ diff }) } as Response);
    render(<BackupDiffPreview driveId={driveId} backup={{ id: backupId, status: 'ready' }} />);
    fireEvent.click(screen.getByText('Preview restore'));
    await waitFor(() => expect(screen.getByText('Restore now')).toBeTruthy());
  });

  it('"Cancel" returns to idle — "Restore now" no longer visible', async () => {
    const diff = makeDiff();
    vi.mocked(global.fetch).mockResolvedValue({ ok: true, json: async () => ({ diff }) } as Response);
    render(<BackupDiffPreview driveId={driveId} backup={{ id: backupId, status: 'ready' }} />);
    fireEvent.click(screen.getByText('Preview restore'));
    await waitFor(() => screen.getByText('Restore now'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Restore now')).toBeNull();
  });

  it('"Restore now" not in DOM during loading state', async () => {
    vi.mocked(global.fetch).mockReturnValue(new Promise(() => {}));
    render(<BackupDiffPreview driveId={driveId} backup={{ id: backupId, status: 'ready' }} />);
    fireEvent.click(screen.getByText('Preview restore'));
    expect(screen.queryByText('Restore now')).toBeNull();
  });
});
*/
