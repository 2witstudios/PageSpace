import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { pageTabOf, tabLabelFor } from './tab-label';

describe('tabLabelFor() (IMC-1.5)', () => {
  test('pages read their title from the page API', () => {
    assert({
      given: 'a page under Files, Messages, Tasks and a public page',
      should: 'name the page id to load',
      actual: ['/d1/files/p1', '/d1/messages/p2', '/d1/tasks/p3', '/p/p4'].map(tabLabelFor),
      expected: [
        { kind: 'page', pageId: 'p1' },
        { kind: 'page', pageId: 'p2' },
        { kind: 'page', pageId: 'p3' },
        { kind: 'page', pageId: 'p4' },
      ],
    });
  });

  test('screens carry their nav names (SPEC settings navs)', () => {
    assert({
      given: 'drive tools, drive settings and account screens',
      should: 'title each as its nav row',
      actual: [
        '/d1/calendar', '/d1/members/u1', '/d1/settings', '/d1/settings/roles', '/d1/settings/danger',
        '/account', '/account/profile', '/account/account', '/account/ai', '/account/local-mcp', '/account/legal/oss-licenses',
      ].map((path) => {
        const label = tabLabelFor(path);
        return label.kind === 'screen' ? label.title : label.kind;
      }),
      expected: [
        'Calendar', 'Members', 'Overview', 'Members & roles', 'Danger zone',
        'Overview', 'Profile', 'Profile', 'AI providers', 'Local MCP', 'Legal',
      ],
    });
  });

  test('a direct message', () => {
    assert({
      given: 'a DM conversation',
      should: 'name the conversation to load',
      actual: tabLabelFor('/dm/c1'),
      expected: { kind: 'conversation', conversationId: 'c1' },
    });
  });
});

describe('tabLabelFor() notifications (IMC-9.14)', () => {
  test('the page is named Notifications', () => {
    assert({
      given: '/notifications',
      should: 'label its tab Notifications, not a drive tool',
      actual: tabLabelFor('/notifications'),
      expected: { kind: 'screen', title: 'Notifications' },
    });
  });
});

describe('pageTabOf()', () => {
  test('the page API body', () => {
    assert({
      given: 'GET /api/pages/[id] for a channel',
      should: 'title it with a # and its type',
      actual: pageTabOf({ title: 'launch-ops', type: 'CHANNEL' }),
      expected: { title: '#launch-ops', type: 'CHANNEL' },
    });
  });

  test('a document', () => {
    assert({
      given: 'a document',
      should: 'keep its title',
      actual: pageTabOf({ title: 'Q4 Launch Plan', type: 'DOCUMENT' }),
      expected: { title: 'Q4 Launch Plan', type: 'DOCUMENT' },
    });
  });

  test('not loaded or not a page', () => {
    assert({
      given: 'nothing yet, and a body with no title',
      should: 'have no label yet',
      actual: [pageTabOf(undefined), pageTabOf({ type: 'DOCUMENT' })],
      expected: [null, null],
    });
  });
});
