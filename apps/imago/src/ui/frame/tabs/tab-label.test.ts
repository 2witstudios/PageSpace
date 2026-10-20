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
        '/d1/calendar/view', '/d1/members/u1', '/d1/settings/overview', '/d1/settings/roles', '/d1/settings/danger',
        '/account/overview', '/account/profile', '/account/account', '/account/ai', '/account/local-mcp', '/account/legal/oss-licenses',
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

  test('drive tools carry their spine icon', () => {
    assert({
      given: 'Console (the drive agents tool) and a drive settings screen',
      should: "give the tool its spine icon and leave settings to the tab's default",
      actual: [tabLabelFor('/d1/agents/view'), tabLabelFor('/d1/settings/overview')],
      expected: [{ kind: 'screen', title: 'Console', icon: 'console' }, { kind: 'screen', title: 'Overview' }],
    });
  });

  test('a Tasks smart view', () => {
    assert({
      given: 'a smart view’s path, and one naming no view',
      should: 'title it as the view with the Tasks icon, never read "view" as a page id',
      actual: [tabLabelFor('/d1/tasks/view/overdue'), tabLabelFor('/d1/tasks/view/nope')],
      expected: [{ kind: 'screen', title: 'Overdue', icon: 'tasks' }, { kind: 'screen', title: 'Tasks', icon: 'tasks' }],
    });
  });

  test("the drive's home", () => {
    assert({
      given: 'a path that is the drive alone, where New tab opens',
      should: 'read as the home',
      actual: tabLabelFor('/d1'),
      expected: { kind: 'home' },
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

  test('a segment that is not valid percent-encoding', () => {
    assert({
      given: 'a path whose segment carries a malformed escape, as a mistyped URL or stored tab can',
      should: 'read the raw segment rather than throw while rendering',
      actual: [
        tabLabelFor('/d1/files/%E0'),
        tabLabelFor('/dm/%E0'),
        tabLabelFor('/d1/settings/%E0'),
      ],
      expected: [
        { kind: 'page', pageId: '%E0' },
        { kind: 'conversation', conversationId: '%E0' },
        { kind: 'screen', title: 'Drive settings' },
      ],
    });
  });

  test('a segment that is valid percent-encoding', () => {
    assert({
      given: 'a path whose ids are percent-encoded',
      should: 'read the decoded ids',
      actual: [tabLabelFor('/d1/files/%70%31'), tabLabelFor('/%64%31/files/p1')],
      expected: [
        { kind: 'page', pageId: 'p1' },
        { kind: 'page', pageId: 'p1' },
      ],
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


test('organization settings have account screen labels instead of a fictitious drive', () => {
  assert({ given: 'the org hub and its wallet pool billing destination', should: 'name their actual screens', actual: [tabLabelFor('/orgs/org-1/settings'), tabLabelFor('/orgs/org-1/settings/billing')], expected: [{ kind: 'screen', title: 'Organization settings' }, { kind: 'screen', title: 'Plan & seats' }] });
});
