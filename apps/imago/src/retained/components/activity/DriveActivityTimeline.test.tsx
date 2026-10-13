// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import type { ActivityLog, Pagination } from './types';
import { DriveActivityTimeline } from './DriveActivityTimeline';

const nav = vi.hoisted(() => ({ search: '' }));
const api = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), post: vi.fn() }));

vi.mock('@/retained-adapters/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@/retained/lib/auth/auth-fetch', () => api);

const row = (overrides: Partial<ActivityLog>): ActivityLog => ({
  id: 'act-1',
  timestamp: '2026-10-12T10:00:00.000Z',
  userId: 'u1',
  actorEmail: 'dana@example.com',
  actorDisplayName: 'Dana',
  operation: 'update',
  resourceType: 'page',
  resourceId: 'p1',
  resourceTitle: 'Status page copy',
  driveId: 'd1',
  pageId: 'p1',
  isAiGenerated: false,
  aiProvider: null,
  aiModel: null,
  aiConversationId: null,
  changeGroupId: null,
  updatedFields: null,
  previousValues: null,
  newValues: null,
  metadata: null,
  rollbackFromActivityId: null,
  rollbackSourceOperation: null,
  rollbackSourceTimestamp: null,
  rollbackSourceTitle: null,
  user: null,
  ...overrides,
});

const pagination = (total: number): Pagination => ({ total, limit: 50, offset: 0, hasMore: false });

const settle = async (check: () => void): Promise<void> => {
  for (let tries = 0; tries < 100; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      check();
      return;
    } catch {
      // Not yet: flush again.
    }
  }
  check();
};

const respondWith = (activities: ActivityLog[], total: number) => {
  api.fetchWithAuth.mockImplementation(async () => Response.json({ activities, pagination: pagination(total) }));
};

beforeEach(() => {
  nav.search = '';
  api.fetchWithAuth.mockReset();
  api.post.mockReset();
});

afterEach(() => {
  unmountAll();
});

describe('DriveActivityTimeline', () => {
  test('shows the range and the total in a 44px Activity toolbar', async () => {
    respondWith([row({ id: 'a' })], 146);
    const container = mount(<DriveActivityTimeline driveId="d1" />);
    await settle(() => expect(container.querySelector('[role="toolbar"][aria-label="Activity"]')?.textContent).toContain('146 events'));
    assert({
      given: 'a drive with 146 events in the default window',
      should: 'show "Last 7 days" and "146 events" in the Activity toolbar',
      actual: container.querySelector('[role="toolbar"][aria-label="Activity"]')?.textContent,
      expected: 'Last 7 days146 events',
    });
  });

  test('requests the drive from the URL filters', async () => {
    nav.search = 'operation=move&range=30d';
    respondWith([], 0);
    mount(<DriveActivityTimeline driveId="d1" />);
    await settle(() => expect(api.fetchWithAuth).toHaveBeenCalled());
    const url = new URL(`http://x${String(api.fetchWithAuth.mock.calls[0]?.[0])}`);
    assert({
      given: 'an operation filter and a 30 day range in the URL',
      should: 'query the drive with that operation and a 50 row first page',
      actual: [url.pathname, url.searchParams.get('context'), url.searchParams.get('operation'), url.searchParams.get('limit'), url.searchParams.get('offset')],
      expected: ['/api/activities', 'drive', 'move', '50', '0'],
    });
  });

  test('marks a change that a later rollback undid as Rolled back, with no undo on it', async () => {
    respondWith(
      [
        row({ id: 'undo', operation: 'rollback', rollbackFromActivityId: 'orig', resourceTitle: 'Brand Voice' }),
        row({ id: 'orig', operation: 'update', resourceTitle: 'Brand Voice' }),
      ],
      2,
    );
    const container = mount(<DriveActivityTimeline driveId="d1" />);
    await settle(() => expect(container.textContent).toContain('Rolled back'));
    const undoButtons = Array.from(container.querySelectorAll('button')).filter((node) => node.textContent === 'Undo this');
    assert({
      given: 'a rollback row that points back at the original change',
      should: 'mark the original Rolled back and offer undo only on the rollback row',
      actual: { rolledBack: container.textContent?.match(/Rolled back/g)?.length, undo: undoButtons.length },
      expected: { rolledBack: 1, undo: 1 },
    });
  });

  test('reports the failure when the activity cannot be loaded', async () => {
    api.fetchWithAuth.mockImplementation(async () => Response.json({ error: 'Forbidden' }, { status: 403 }));
    const container = mount(<DriveActivityTimeline driveId="d1" />);
    await settle(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    assert({
      given: 'the activity request is refused',
      should: 'say why in an alert rather than an empty timeline',
      actual: container.querySelector('[role="alert"]')?.textContent,
      expected: 'Forbidden',
    });
  });
});
