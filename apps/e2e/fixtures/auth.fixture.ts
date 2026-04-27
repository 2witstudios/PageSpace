import { test as base } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const seedState = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../.seed-state.json'), 'utf-8'),
) as { userId: string; driveId: string };

export const test = base.extend<{ driveId: string }>({
  driveId: async ({}, use) => {
    await use(seedState.driveId);
  },
});

export { expect } from '@playwright/test';
