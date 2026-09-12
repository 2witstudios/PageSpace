import { test, expect } from '../fixtures/auth.fixture';

// Mocks /api/pulse so the Home signal line renders deterministically without
// seeding real mentions/tasks/invites — the composition itself is covered by
// packages/lib's persona fixture tests; these assert the wiring: the line
// renders, the quiet state renders, and a suggestion seeds the composer
// without sending.

const now = new Date().toISOString();

function pulseResponse(overrides: Partial<{
  signals: unknown[];
  context: Record<string, unknown>;
}> = {}) {
  return {
    summary: null,
    stats: {
      tasks: { dueToday: 0, dueThisWeek: 0, overdue: 0, completedThisWeek: 0 },
      messages: { unreadCount: 0 },
      pages: { updatedToday: 0, updatedThisWeek: 0 },
      calendar: { upcomingToday: 0, pendingInvites: 0 },
    },
    shouldRefresh: false,
    signals: overrides.signals ?? [],
    context: {
      userId: 'seed-user',
      displayName: 'Jono',
      timezone: 'UTC',
      driveIds: ['d1'],
      drivesInUse: ['d1'],
      lastVisitAt: now,
      pulseEnabled: true,
      ...overrides.context,
    },
  };
}

const mentionSignal = {
  kind: 'mention',
  count: 1,
  subject: { type: 'page', id: 'p1', title: 'design-review' },
  window: { since: now, kind: 'today' },
  computedAt: now,
  text: { lead: 'Sarah is waiting on you in design-review', short: 'Sarah in design-review' },
  action: { prompt: 'Reply to Sarah' },
};

const overdueSignal = {
  kind: 'overdue_task',
  count: 1,
  window: { since: now, kind: 'today' },
  computedAt: now,
  text: { lead: '1 task overdue', short: '1 task overdue' },
  action: { prompt: 'What is overdue?' },
};

test('shows the mention as the lead fact when the user has something waiting', async ({ page }) => {
  await page.route('**/api/pulse', (route) =>
    route.fulfill({ json: pulseResponse({ signals: [mentionSignal, overdueSignal] }) }),
  );
  await page.goto('/dashboard');

  await expect(page.getByText('Sarah is waiting on you in design-review')).toBeVisible();
  await expect(page.getByText('1 task overdue')).toBeVisible();
});

test('shows the quiet state with no lead fact when nothing is waiting', async ({ page }) => {
  await page.route('**/api/pulse', (route) => route.fulfill({ json: pulseResponse({ signals: [] }) }));
  await page.goto('/dashboard');

  await expect(page.getByText(/All caught up across/)).toBeVisible();
});

test('clicking a suggestion seeds the composer without sending it', async ({ page }) => {
  await page.route('**/api/pulse', (route) =>
    route.fulfill({ json: pulseResponse({ signals: [mentionSignal] }) }),
  );

  // The real global-assistant send endpoint (POST /api/ai/global/[id]/messages,
  // per app/api/ai/global/route.ts) — this is the pattern a wrongly-triggered
  // send would actually hit, unlike a generic /api/conversations/* guess.
  let sendRequestSeen = false;
  await page.route('**/api/ai/global/**/messages**', (route) => {
    sendRequestSeen = true;
    return route.continue();
  });

  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Reply to Sarah' }).click();

  const textarea = page.getByTestId('chat-textarea');
  await expect(textarea).toHaveValue('Reply to Sarah');
  // Give a real send request a moment to land if the click had wrongly
  // triggered one — a passing assertion here proves absence, not silence.
  await page.waitForTimeout(300);
  expect(sendRequestSeen).toBe(false);
});
