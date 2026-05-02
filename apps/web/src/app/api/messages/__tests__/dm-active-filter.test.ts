import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRoute(relativePath: string): string {
  return readFileSync(resolve(apiRoot, relativePath), 'utf8');
}

describe('DM inactive filtering contract', () => {
  it('given_unreadDmCounts_excludesInactiveRows', () => {
    const activePredicate = 'eq(directMessages.isActive, true)';
    const routes = [
      'activity/summary/route.ts',
      'pulse/route.ts',
    ];

    for (const route of routes) {
      expect(readRoute(route)).toContain(activePredicate);
    }
  });

  it('given_unreadDmContentFeedsPulseAi_excludesInactiveRows', () => {
    const activePredicate = 'eq(directMessages.isActive, true)';
    const routes = [
      'pulse/generate/route.ts',
      'pulse/cron/route.ts',
    ];

    for (const route of routes) {
      expect(readRoute(route)).toContain(activePredicate);
    }
  });

  it('given_messageThreadsUnreadSql_excludesInactiveRows', () => {
    expect(readRoute('messages/threads/route.ts')).toContain('dm."isActive" = true');
  });
});
