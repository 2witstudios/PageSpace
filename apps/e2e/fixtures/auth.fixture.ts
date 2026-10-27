import { test as base } from '@playwright/test';
import { getSeedState } from './seed-state';

export const test = base.extend<{ driveId: string }>({
  driveId: async ({}, use) => {
    await use(getSeedState().driveId);
  },
});

export { expect } from '@playwright/test';
