import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A plain alert rendered on every platform, including the iOS app (3.1.1).
describe('StorageUsageCard critical-storage copy', () => {
  it('given critical storage use, should not tell the user to upgrade their plan', () => {
    const source = readFileSync(join(__dirname, '../StorageUsageCard.tsx'), 'utf8');
    expect(source).not.toMatch(/upgrad(e|ing) your plan/i);
  });
});
