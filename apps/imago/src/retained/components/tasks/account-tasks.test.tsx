// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { useLayoutStore } from '@/retained/stores/useLayoutStore';
import { TasksDashboard } from './TasksDashboard';
import { fetchDueChipCounts, groupTasksByDrive } from './account-tasks';
import type { Task } from './types';
import type { Drive } from '@pagespace/lib/types';

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@/retained-adapters/navigation', () => {
  const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
  const searchParams = new URLSearchParams();
  return {
    useRouter: () => router,
    usePathname: () => '/account/tasks',
    useSearchParams: () => searchParams,
  };
});

vi.mock('@/retained/hooks/useMobile', () => ({ useMobile: () => false }));
vi.mock('@/retained/hooks/useCapacitor', () => ({ useCapacitor: () => ({ isNative: false }) }));
vi.mock('@/retained/components/ui/pull-to-refresh', () => ({
  PullToRefresh: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/retained/components/ui/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const fetchMock = vi.mocked(fetchWithAuth);

const task = (overrides: Partial<Task> & Pick<Task, 'id' | 'title' | 'driveId'>): Task => ({
  userId: 'u1',
  assigneeId: 'u1',
  assigneeAgentId: null,
  pageId: null,
  status: 'pending',
  priority: 'medium',
  position: 0,
  dueDate: null,
  completedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  assignee: null,
  assigneeAgent: null,
  user: null,
  page: null,
  taskListPageId: 'list-1',
  taskListPageTitle: 'Launch Tasks',
  statusGroup: 'todo',
  statusLabel: 'Pending',
  statusColor: 'bg-slate-100 text-slate-600',
  ...overrides,
});

const drive = (id: string, name: string): Drive => ({
  id,
  name,
  slug: id,
  ownerId: 'u1',
  isTrashed: false,
  trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isOwned: true,
});

const DRIVES: Drive[] = [drive('d-studio', 'Studio'), drive('d-ops', 'Ops')];

const DUE_TOTALS: Record<string, number> = { overdue: 1, today: 2, this_week: 5, upcoming: 2 };

let listTasks: Task[] = [];

const listResponse = (tasks: Task[]) =>
  Response.json({
    tasks,
    statusConfigsByTaskList: {},
    pagination: { total: tasks.length, limit: 50, offset: 0, hasMore: false },
  });

function installFetch(): void {
  fetchMock.mockImplementation(async (url: string) => {
    const params = new URL(url, 'http://localhost').searchParams;
    if (params.get('limit') === '1') {
      const total = DUE_TOTALS[params.get('dueDateFilter') ?? ''] ?? 0;
      return Response.json({ tasks: [], statusConfigsByTaskList: {}, pagination: { total, limit: 1, offset: 0, hasMore: false } });
    }
    if (params.get('statusGroup') === 'completed') return listResponse([]);
    return listResponse(listTasks);
  });
}

beforeEach(() => {
  // Filters persist per scope; a filter left by one test must not reach the next.
  useLayoutStore.setState({ tasksDashboardFilters: {} });
  listTasks = [
    task({ id: 't1', title: 'Confirm payment provider sign-off', driveId: 'd-studio', dueDate: '2026-10-09T09:00:00.000Z' }),
    task({ id: 't2', title: 'Review pricing FAQ draft', driveId: 'd-studio' }),
    task({ id: 't3', title: 'Raise the Ops wallet allocation', driveId: 'd-ops', taskListPageTitle: 'Ops admin' }),
  ];
  useDriveStore.setState({ drives: DRIVES });
  installFetch();
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe('groupTasksByDrive', () => {
  test('groups loaded tasks under their drive, in the drive list order', () => {
    const groups = groupTasksByDrive(
      [
        task({ id: 'a', title: 'A', driveId: 'd-ops' }),
        task({ id: 'b', title: 'B', driveId: 'd-studio' }),
        task({ id: 'c', title: 'C', driveId: 'd-ops' }),
      ],
      DRIVES,
    );

    expect(groups.map((g) => [g.name, g.initial, g.tasks.length])).toEqual([
      ['Studio', 'S', 1],
      ['Ops', 'O', 2],
    ]);
  });

  test('puts tasks from a drive outside the list after the known drives', () => {
    const groups = groupTasksByDrive(
      [task({ id: 'x', title: 'X', driveId: 'd-gone' }), task({ id: 'y', title: 'Y', driveId: 'd-ops' })],
      DRIVES,
    );

    expect(groups.map((g) => g.name)).toEqual(['Ops', 'Unknown drive']);
  });
});

describe('fetchDueChipCounts', () => {
  test('reads each chip count from a one-row request scoped like the list', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      const params = new URL(url, 'http://localhost').searchParams;
      const total = DUE_TOTALS[params.get('dueDateFilter') ?? ''] ?? 0;
      return Response.json({ tasks: [], statusConfigsByTaskList: {}, pagination: { total, limit: 1, offset: 0, hasMore: false } });
    });

    const counts = await fetchDueChipCounts({ statusGroup: 'active', assigneeFilter: 'mine', driveId: 'd-ops' });

    expect(counts).toEqual({ overdue: 1, today: 2, this_week: 5, upcoming: 2 });
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://localhost').searchParams);
    expect(urls).toHaveLength(4);
    for (const params of urls) {
      expect(params.get('context')).toBe('user');
      expect(params.get('limit')).toBe('1');
      expect(params.get('statusGroup')).toBe('active');
      expect(params.get('driveId')).toBe('d-ops');
      expect(params.has('showAllAssignees')).toBe(false);
    }
  });

  test('leaves a chip without a count when its request fails', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      const params = new URL(url, 'http://localhost').searchParams;
      if (params.get('dueDateFilter') === 'today') return new Response('no', { status: 500 });
      return Response.json({ tasks: [], statusConfigsByTaskList: {}, pagination: { total: 3, limit: 1, offset: 0, hasMore: false } });
    });

    const counts = await fetchDueChipCounts({ statusGroup: 'all', assigneeFilter: 'all' });

    expect(counts).toEqual({ overdue: 3, this_week: 3, upcoming: 3 });
  });
});

describe('Account › Tasks view', () => {
  test('renders My tasks, the status segment, due chips with counts and the drive select', async () => {
    render(<TasksDashboard />);

    expect(await screen.findByRole('heading', { level: 1, name: 'My tasks' })).toBeTruthy();

    const status = screen.getByRole('group', { name: 'Status' });
    expect(within(status).getByRole('button', { name: 'Active' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(status).getByRole('button', { name: 'Completed' }).getAttribute('aria-pressed')).toBe('false');
    expect(within(status).getByRole('button', { name: 'All' })).toBeTruthy();

    const due = screen.getByRole('group', { name: 'Due' });
    await waitFor(() => expect(within(due).getByRole('button', { name: /Overdue/ }).textContent).toContain('1'));
    expect(within(due).getByRole('button', { name: /Today/ }).textContent).toContain('2');
    expect(within(due).getByRole('button', { name: /This week/ }).textContent).toContain('5');
    expect(within(due).getByRole('button', { name: /Upcoming/ }).textContent).toContain('2');

    expect(screen.getByRole('combobox', { name: 'Drive' }).textContent).toContain('All drives');
  });

  test('keeps the include-my-agents switch hidden until the API supports it', async () => {
    render(<TasksDashboard />);
    await screen.findByRole('heading', { level: 1, name: 'My tasks' });

    expect(screen.queryByText(/Include my agents/)).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  test('groups rows under their drive heading with the count of loaded tasks', async () => {
    render(<TasksDashboard />);

    const studio = await screen.findByRole('region', { name: 'Studio' });
    expect(within(studio).getByText('Confirm payment provider sign-off')).toBeTruthy();
    expect(within(studio).getByText('Review pricing FAQ draft')).toBeTruthy();
    expect(within(studio).getByRole('heading', { name: /Studio/ }).textContent).toContain('2');

    const ops = screen.getByRole('region', { name: 'Ops' });
    expect(within(ops).getByText('Raise the Ops wallet allocation')).toBeTruthy();
    expect(within(ops).queryByText('Review pricing FAQ draft')).toBeNull();
  });

  test('switching to Completed requests the completed group and marks it pressed', async () => {
    render(<TasksDashboard />);
    await screen.findByRole('region', { name: 'Studio' });

    fireEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Completed' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => new URL(String(url), 'http://localhost').searchParams.get('statusGroup') === 'completed'),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Completed' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    expect(await screen.findByText('No tasks found')).toBeTruthy();
  });

  test('the overdue chip filters by dueDateFilter and a second press clears it', async () => {
    render(<TasksDashboard />);
    await screen.findByRole('region', { name: 'Studio' });

    const overdue = within(screen.getByRole('group', { name: 'Due' })).getByRole('button', { name: /Overdue/ });
    fireEvent.click(overdue);

    await waitFor(() => expect(overdue.getAttribute('aria-pressed')).toBe('true'));
    expect(
      fetchMock.mock.calls.some(([url]) => new URL(String(url), 'http://localhost').searchParams.get('dueDateFilter') === 'overdue'),
    ).toBe(true);

    fireEvent.click(overdue);
    await waitFor(() => expect(overdue.getAttribute('aria-pressed')).toBe('false'));
  });
});
