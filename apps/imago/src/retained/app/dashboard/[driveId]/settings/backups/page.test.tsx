// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { SWRConfig } from 'swr';
import { format } from 'date-fns';
import { click, mount, typeInto, unmountAll } from '@/ui/test-support/dom';
import DriveBackupsPage, { backupMeta, runAtLabel, scheduleBody } from './page';

const spies = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), post: vi.fn(), patch: vi.fn() }));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: spies.fetchWithAuth,
  post: spies.post,
  patch: spies.patch,
  del: vi.fn(),
}));
vi.mock('@/retained-adapters/navigation', () => ({
  useParams: () => ({ driveId: 'd1' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/retained-adapters/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));
vi.mock('@/retained/hooks/useDrive', () => ({
  useDriveStore: (selector: (state: unknown) => unknown) =>
    selector({ drives: [{ id: 'd1', name: 'Studio', isOwned: true }], isLoading: false, fetchDrives: vi.fn() }),
}));
vi.mock('@/retained/components/billing/UpgradeLink', () => ({
  UpgradeLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Radix measures its switch and selects with ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

afterEach(unmountAll);

const SCHEDULE = {
  available: true,
  enabled: true,
  frequency: 'weekly',
  timezone: 'Europe/London',
  nextRunAt: '2026-10-13T02:00:00Z',
  lastRunAt: '2026-10-06T02:00:00Z',
};

const backup = (id: string, label: string | null, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  label,
  source: 'manual',
  status,
  createdAt: '2026-10-06T02:00:00Z',
  completedAt: status === 'ready' ? '2026-10-06T02:04:00Z' : null,
  failedAt: null,
  failureReason: null,
  ...extra,
});

let backups: ReturnType<typeof backup>[] = [];
const json = (body: unknown) => Promise.resolve(Response.json(body));

beforeEach(() => {
  backups = [backup('b1', 'Weekly backup', 'ready')];
  spies.fetchWithAuth.mockReset().mockImplementation((url: string) => {
    if (url.includes('/backups/schedule')) return json(SCHEDULE);
    if (url.startsWith('/api/drives/d1/backups?')) {
      const { searchParams } = new URL(url, 'http://imago.test');
      const offset = Number(searchParams.get('offset'));
      return json({ backups: backups.slice(offset, offset + 10) });
    }
    return json({});
  });
  spies.post.mockReset();
  spies.patch.mockReset().mockResolvedValue({ ...SCHEDULE, enabled: false });
});

const render = () =>
  mount(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DriveBackupsPage />
    </SWRConfig>,
  );

const settle = async (check: () => void): Promise<void> => {
  for (let tries = 0; tries < 100; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      check();
      return;
    } catch {
      // Not yet.
    }
  }
  check();
};

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null;

const headings = (container: HTMLElement) => [...container.querySelectorAll('h2')].map((h) => h.textContent);

describe('DriveBackupsPage', () => {
  test('draws the three sections of the board with no Back to Settings button', async () => {
    const container = render();
    await settle(() => {
      if (container.querySelector('[data-backup-status="ready"]') === null) throw new Error('not yet');
    });
    assert({
      given: 'a drive with one ready backup',
      should: 'show Automatic backups, Create a backup now and History, the drive name in the lede, and no Back to Settings',
      actual: {
        headings: headings(container),
        lede: container.textContent?.includes('in Studio.') ?? false,
        back: button(container, 'Back to Settings') !== null,
      },
      expected: {
        headings: ['Automatic backups', 'Create a backup now', 'History'],
        lede: true,
        back: false,
      },
    });
  });

  test('a labelled backup posts the label, shows a pending row, then the ready row with View & restore', async () => {
    let answer!: (value: unknown) => void;
    spies.post.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const container = render();
    await settle(() => {
      if (container.querySelector('#backup-label') === null) throw new Error('not yet');
    });
    typeInto(container.querySelector('#backup-label') as HTMLInputElement, 'Before launch freeze');
    click(button(container, 'Create backup')!);
    await settle(() => {
      if (container.querySelector('[data-backup-status="pending"]') === null) throw new Error('not yet');
    });
    const pendingText = container.querySelector('[data-backup-status="pending"]')?.textContent ?? '';
    backups = [backup('b2', 'Before launch freeze', 'ready'), ...backups];
    answer({ backupId: 'b2', status: 'ready', counts: { pages: 1, permissions: 0, members: 1, roles: 1, files: 0 } });
    await settle(() => {
      if (container.querySelector('[data-backup-status="ready"] a') === null) throw new Error('not yet');
    });
    const ready = container.querySelector('[data-backup-status="ready"]');
    assert({
      given: 'a labelled Create backup',
      should: 'POST a manual backup with the label, show it pending, then ready with View & restore to its snapshot',
      actual: {
        post: spies.post.mock.calls[0],
        pending: pendingText.includes('Before launch freeze') && pendingText.includes('Creating'),
        pendingGone: container.querySelector('[data-backup-status="pending"]') === null,
        viewLink: ready?.querySelector('a')?.getAttribute('href') ?? null,
      },
      expected: {
        post: ['/api/drives/d1/backups', { source: 'manual', label: 'Before launch freeze' }],
        pending: true,
        pendingGone: true,
        viewLink: '/account/backups/b2/snapshot',
      },
    });
  });

  test('turning automatic backups off PATCHes the schedule and keeps its frequency and timezone', async () => {
    const container = render();
    await settle(() => {
      if (container.querySelector('button[role="switch"]') === null) throw new Error('not yet');
    });
    click(container.querySelector('button[role="switch"]') as HTMLElement);
    await settle(() => {
      if (spies.patch.mock.calls.length === 0) throw new Error('not yet');
    });
    assert({
      given: 'the Automatic backups switch turned off',
      should: 'PATCH enabled false with the current frequency and timezone',
      actual: spies.patch.mock.calls[0],
      expected: ['/api/drives/d1/backups/schedule', { enabled: false, frequency: 'weekly', timezone: 'Europe/London' }],
    });
  });

  test('Load more fetches the next page of history at the current offset', async () => {
    backups = Array.from({ length: 11 }, (_, i) => backup(`b${i + 1}`, `Backup ${i + 1}`, 'ready'));
    const container = render();
    await settle(() => {
      if (button(container, 'Load more') === null) throw new Error('not yet');
    });
    click(button(container, 'Load more')!);
    await settle(() => {
      if (container.querySelectorAll('[data-backup-status="ready"]').length < 11) throw new Error('not yet');
    });
    assert({
      given: 'a full first page of ten backups and an eleventh behind Load more',
      should: 'request offset 10 and list all eleven rows',
      actual: {
        requested: spies.fetchWithAuth.mock.calls.some(([url]) => String(url).includes('offset=10')),
        rows: container.querySelectorAll('[data-backup-status="ready"]').length,
      },
      expected: { requested: true, rows: 11 },
    });
  });
});

describe('backups helpers', () => {
  test('a frequency change keeps the switch and the timezone of the schedule', () => {
    assert({
      given: 'a weekly schedule in London changed to monthly',
      should: 'send the whole schedule with the new frequency',
      actual: scheduleBody({ enabled: true, frequency: 'weekly', timezone: 'Europe/London' }, { frequency: 'monthly' }),
      expected: { enabled: true, frequency: 'monthly', timezone: 'Europe/London' },
    });
  });

  test('a run time is shown in the schedule timezone, not the browser', () => {
    assert({
      given: 'a 02:00 UTC run in October, when London is on BST',
      should: 'show 03:00 in Europe/London',
      actual: runAtLabel('2026-10-13T02:00:00Z', 'Europe/London')?.includes('03:00') ?? false,
      expected: true,
    });
  });

  test('a failed backup shows its reason, a ready one when it completed', () => {
    assert({
      given: 'a failed and a ready backup',
      should: 'show the failure reason on failed and the completion time on ready',
      actual: [
        backupMeta(backup('f', null, 'failed', { failureReason: 'file copy timed out' })).endsWith('failed: file copy timed out'),
        backupMeta(backup('r', null, 'ready')).includes(`completed ${format(new Date('2026-10-06T02:04:00Z'), 'HH:mm')}`),
      ],
      expected: [true, true],
    });
  });
});
