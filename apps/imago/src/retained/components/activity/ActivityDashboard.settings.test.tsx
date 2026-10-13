// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import type { ActivityLog, Pagination } from './types';
import { ActivityDashboard } from './ActivityDashboard';

const nav = vi.hoisted(() => ({ search: '' }));
const api = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), post: vi.fn() }));

vi.mock('@/retained-adapters/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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

/** Answers the drives, actors and activity routes the screen calls. */
const respond = (activities: ActivityLog[]) => {
  api.fetchWithAuth.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/drives')) return Response.json([{ id: 'd1', name: 'Studio' }]);
    if (url.startsWith('/api/activities/actors')) return Response.json([]);
    return Response.json({ activities, pagination: pagination(activities.length) });
  });
};

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

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
  nav.search = '';
  api.fetchWithAuth.mockReset();
  api.post.mockReset();
});

afterEach(() => {
  unmountAll();
});

describe('ActivityDashboard (settings variant)', () => {
  test('renders the Your activity screen with a Filters toolbar, the drive on each row and no dashboard Back or Refresh', async () => {
    respond([row({ id: 'act-1', driveId: 'd1' })]);
    const container = mount(<ActivityDashboard context="user" variant="settings" />);
    await settle(() => {
      expect(container.textContent).toContain('Status page copy');
    });
    assert({
      given: 'the account activity screen with one change in the Studio drive',
      should: 'show the Your activity heading, the Filters toolbar, the change with its drive, and no Back or Refresh buttons',
      actual: {
        heading: container.querySelector('h1')?.textContent,
        toolbar: container.querySelector('[role="toolbar"][aria-label="Filters"]') !== null,
        drive: container.textContent?.includes('in Studio'),
        buttons: [...container.querySelectorAll('button')].map((node) => node.textContent?.trim()).filter((text) => text === 'Back' || text === 'Refresh'),
      },
      expected: { heading: 'Your activity', toolbar: true, drive: true, buttons: [] },
    });
  });

  test('an empty log shows the empty message in the settings screen', async () => {
    respond([]);
    const container = mount(<ActivityDashboard context="user" variant="settings" />);
    await settle(() => {
      expect(container.textContent).toContain('No activity found');
    });
    assert({
      given: 'no changes in the log',
      should: 'show the empty message under the Filters toolbar',
      actual: container.querySelector('[role="toolbar"][aria-label="Filters"]') !== null,
      expected: true,
    });
  });
});
