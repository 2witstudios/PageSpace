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

// Thread replies must NEVER inflate inbox/pulse/activity DM counts. Default
// is "thread reply does not bump conversation unread"; PR 5 will reintroduce
// thread-specific unread via thread_updated for explicit followers.
describe('DM thread-reply isolation contract', () => {
  it('given_unreadDmCounts_excludesThreadReplies', () => {
    const parentNullPredicate = 'isNull(directMessages.parentId)';
    const routes = [
      'activity/summary/route.ts',
      'pulse/route.ts',
      'pulse/generate/route.ts',
      'pulse/cron/route.ts',
    ];

    for (const route of routes) {
      expect(readRoute(route)).toContain(parentNullPredicate);
    }
  });

  it('given_messageThreadsInboxSql_excludesThreadReplies', () => {
    const source = readRoute('messages/threads/route.ts');
    // DM unread CTE
    expect(source).toContain('dm."parentId" IS NULL');
    // Channel "last message" CTE
    expect(source).toContain('cm."parentId" IS NULL');
  });
});
