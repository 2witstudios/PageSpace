// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HistoryVersion } from './page-history-model';
import SidebarActivityTab from './SidebarActivityTab';

const api = vi.hoisted(() => ({ fetchJSON: vi.fn(), post: vi.fn() }));

vi.mock('@/retained/lib/auth/auth-fetch', () => api);
vi.mock('@/retained/hooks/useActivitySocket', () => ({ useActivitySocket: () => undefined }));

const versions: HistoryVersion[] = [
  {
    id: 'h1', timestamp: new Date().toISOString(), userId: 'u1', actorEmail: 'dana@example.com', actorDisplayName: 'Dana',
    operation: 'updated', resourceTitle: 'Q4 Launch Plan', isAiGenerated: false, aiProvider: null, changeGroupType: 'user',
    updatedFields: ['title'], rollbackFromActivityId: null, canRollback: true,
  },
  {
    id: 'h2', timestamp: new Date().toISOString(), userId: null, actorEmail: 'agent@example.com', actorDisplayName: 'Imago',
    operation: 'updated', resourceTitle: 'Q4 Launch Plan', isAiGenerated: true, aiProvider: 'openai', changeGroupType: 'ai',
    updatedFields: null, rollbackFromActivityId: null, canRollback: true,
  },
  {
    id: 'h3', timestamp: new Date().toISOString(), userId: 'u2', actorEmail: 'sam@example.com', actorDisplayName: 'Sam',
    operation: 'rollback', resourceTitle: 'Q4 Launch Plan', isAiGenerated: false, aiProvider: null, changeGroupType: 'user',
    updatedFields: null, rollbackFromActivityId: 'h4', canRollback: true,
  },
  {
    id: 'h4', timestamp: new Date(Date.now() - 86_400_000).toISOString(), userId: 'u2', actorEmail: 'sam@example.com', actorDisplayName: 'Sam',
    operation: 'updated', resourceTitle: 'Q4 Launch Plan', isAiGenerated: false, aiProvider: null, changeGroupType: 'user',
    updatedFields: null, rollbackFromActivityId: null, canRollback: true,
  },
];

const preview = {
  action: 'rollback',
  canExecute: true,
  warnings: [],
  hasConflict: false,
  conflictFields: [],
  requiresForce: false,
  isNoOp: false,
  currentValues: null,
  targetValues: null,
  affectedResources: [],
  changes: [{ id: 'c1', label: 'Restore the title', description: 'Q4 Launch Plan' }],
};

beforeEach(() => {
  api.fetchJSON.mockImplementation(async (url: string) => {
    if (url.includes('/rollback-to-point?')) {
      return { activityId: 'h1', context: 'page', pageId: 'page-1', driveId: null, timestamp: new Date(), warnings: [], activitiesAffected: [{ id: 'h1', preview }] };
    }
    if (url.includes('includeAiOnly=true')) {
      return { versions: versions.filter((row) => row.isAiGenerated), retentionDays: 30 };
    }
    return { versions, retentionDays: 30 };
  });
  api.post.mockImplementation(async (url: string) => {
    if (url.endsWith('/rollback-to-point')) {
      return { status: 'success', message: 'Done', warnings: [], changesApplied: [] };
    }
    return { preview };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SidebarActivityTab (page history body)', () => {
  it('loads the page history with the retention meta and groups the rows', async () => {
    render(<SidebarActivityTab pageId="page-1" />);

    expect(await screen.findByText('Last 30 days')).toBeTruthy();
    expect(api.fetchJSON).toHaveBeenCalledWith('/api/pages/page-1/history?limit=50');
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Dana')).toBeTruthy();
    expect(screen.getByText('Imago')).toBeTruthy();
    expect(screen.getByText('AI · asked by you')).toBeTruthy();
    expect(screen.getAllByText('Rolled back')).toHaveLength(1);
  });

  it('filters to AI changes through includeAiOnly', async () => {
    render(<SidebarActivityTab pageId="page-1" />);
    await screen.findByText('Dana');

    fireEvent.click(screen.getByRole('button', { name: 'AI changes' }));

    await waitFor(() => expect(api.fetchJSON).toHaveBeenLastCalledWith('/api/pages/page-1/history?limit=50&includeAiOnly=true'));
    expect(await screen.findByText('Imago')).toBeTruthy();
    expect(screen.queryByText('Dana')).toBeNull();
    expect(screen.getByRole('button', { name: 'AI changes' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('searches the loaded rows by actor and summary', async () => {
    render(<SidebarActivityTab pageId="page-1" />);
    await screen.findByText('Dana');

    fireEvent.change(screen.getByPlaceholderText('Search activity...'), { target: { value: 'changed title' } });

    expect(screen.getByText('Dana')).toBeTruthy();
    expect(screen.queryByText('Imago')).toBeNull();
  });

  it('expands a row into the changes to apply and undoes it through /rollback', async () => {
    render(<SidebarActivityTab pageId="page-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Dana/ }));

    expect(await screen.findByText('Changes to apply')).toBeTruthy();
    expect(screen.getByText('Restore the title')).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith('/api/activities/h1/rollback', { context: 'page', dryRun: true });

    const undo = screen.getByRole('button', { name: 'Undo this change' });
    await waitFor(() => expect((undo as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(undo);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/activities/h1/rollback', { context: 'page', force: false }));
    await waitFor(() => expect(screen.queryByText('Changes to apply')).toBeNull());
  });

  it('marks a rolled-back row and blocks undo on it', async () => {
    render(<SidebarActivityTab pageId="page-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Sam.*Rolled back/ }));

    expect(await screen.findByText('This change has already been rolled back.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Undo this change' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Rollback to this point' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
