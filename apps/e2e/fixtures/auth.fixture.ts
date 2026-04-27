import { test as base } from '@playwright/test';
import { seedState } from './seed-state';

export const test = base.extend<{ driveId: string }>({
  driveId: async ({}, use) => {
    await use(seedState.driveId);
  },
});

export { expect } from '@playwright/test';
