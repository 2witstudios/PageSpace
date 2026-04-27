import { test as base, APIRequestContext } from '@playwright/test';
import { seedState } from './seed-state';

interface SeededPage {
  pageId: string;
  title: string;
}

async function seedPage(request: APIRequestContext): Promise<SeededPage> {
  const csrfResponse = await request.get('/api/auth/csrf');
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const title = `E2E Page ${Date.now()}`;
  const response = await request.post('/api/pages', {
    headers: { 'X-CSRF-Token': csrfToken },
    data: {
      title,
      type: 'DOCUMENT',
      driveId: seedState.driveId,
      parentId: null,
    },
  });

  const page = (await response.json()) as { id: string };
  return { pageId: page.id, title };
}

export const test = base.extend<{ seedPage: () => Promise<SeededPage> }>({
  seedPage: async ({ request }, use) => {
    await use(() => seedPage(request));
  },
});

export { expect } from '@playwright/test';
