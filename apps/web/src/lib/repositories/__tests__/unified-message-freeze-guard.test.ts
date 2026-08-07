/**
 * FREEZE GUARD for the `chat_messages` → `messages` merge (epic
 * "Agent-Session Single Source of Truth", Phase 4 / D6; epic #2161's rule that
 * a forced copy gets a drift-guard test AND a reconciler).
 *
 * This suite used to assert the opposite of what it asserts now, and the
 * inversion IS the point of Phase 4 PR 14. Through PRs 10–13 every page write
 * had to touch BOTH `chat_messages` and `messages`; the copy was forced, so the
 * guard policed the copying. PR 14 stopped the legacy leg, so the brief is now
 * equally blunt in the other direction:
 *
 *   NOTHING MAY INSERT OR UPDATE `chat_messages`. A write that does must fail
 *   this suite.
 *
 * DELETEs are a different statement and stay legal: retention's legacy sweep,
 * GDPR erasure, page teardown and the 0248 FK cascade all still remove rows
 * from that table, and must keep doing so until PR 15 drops it. So the
 * structural scan below splits the two — content writes are forbidden
 * outright, removals are allowlisted with their reasons.
 *
 * Two parts, because one cannot cover both failure modes:
 *
 *   PART 1 — BEHAVIOURAL. Every write path on `messageRepository` is driven
 *   against a recording fake `db` and asserted to touch `messages` and NOT
 *   `chat_messages`, in one transaction. The enumeration is closed: an
 *   unclassified new method also fails, so a future write path cannot be added
 *   without deciding which table it writes.
 *
 *   PART 2 — STRUCTURAL. Part 1 only knows about writers it enumerates, and
 *   the failure mode that matters is a writer nobody remembered to enumerate.
 *   So the source tree is scanned for every statement aimed at `chatMessages`:
 *   the INSERT/UPDATE list must be EMPTY, and the DELETE list must match an
 *   allowlist that carries a reason per entry.
 *
 * The runtime counterpart (did any ROW appear in the frozen table?) is the
 * `reconcile-message-unification` cron; see
 * `@/lib/repositories/message-unification-reconcile` and
 * `./message-unification-freeze-reconcile.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// ---------------------------------------------------------------------------
// A recording fake query builder. Every terminal call resolves to a canned
// result; every chain step is recorded so a test can ask WHICH TABLES a write
// path touched.
// ---------------------------------------------------------------------------

const { touches, makeDb } = vi.hoisted(() => {
  const touches: Array<{ op: string; table: string }> = [];

  /** Chainable + thenable: `await chain`, `await chain.returning()` both work. */
  const makeChain = (result: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const method of [
      'values',
      'set',
      'where',
      'from',
      'onConflictDoUpdate',
      'onConflictDoNothing',
      'returning',
      'limit',
      'for',
      'orderBy',
      'innerJoin',
      'leftJoin',
    ]) {
      chain[method] = (...args: unknown[]) => {
        // `.from(table)` is how a SELECT names its table; record it too, so a
        // read-side change that drops a leg is visible in the trace.
        if (method === 'from' && isTable(args[0])) {
          touches.push({ op: 'select', table: tableName(args[0]) });
        }
        return chain;
      };
    }
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  };

  const isTable = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && '__table' in (value as Record<string, unknown>);
  const tableName = (value: unknown): string =>
    (value as { __table: string }).__table;

  const executor = () => ({
    select: () => makeChain([{ id: 'conv-1', isActive: true }]),
    insert: (table: unknown) => {
      touches.push({ op: 'insert', table: tableName(table) });
      return makeChain([{ id: 'msg-1' }]);
    },
    update: (table: unknown) => {
      touches.push({ op: 'update', table: tableName(table) });
      return makeChain([{ id: 'msg-1' }]);
    },
    delete: (table: unknown) => {
      touches.push({ op: 'delete', table: tableName(table) });
      return makeChain([{ id: 'msg-1' }]);
    },
  });

  const makeDb = () => ({
    ...executor(),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      touches.push({ op: 'begin', table: '(transaction)' });
      const result = await fn(executor());
      touches.push({ op: 'commit', table: '(transaction)' });
      return result;
    },
  });

  return { touches, makeDb };
});

vi.mock('@pagespace/db/db', () => ({ db: makeDb() }));

vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: { __table: 'chat_messages', id: 'x', conversationId: 'x', role: 'x', status: 'x' },
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  messages: { __table: 'messages', id: 'x', conversationId: 'x', role: 'x', status: 'x', isActive: 'x' },
  conversations: { __table: 'conversations', id: 'x', isActive: 'x' },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: (...a: unknown[]) => ({ eq: a }),
  and: (...a: unknown[]) => ({ and: a }),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { debug: vi.fn(), trace: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    api: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/ai/global-channel-id', () => ({
  globalChannelId: (userId: string) => `user:${userId}:global`,
}));

vi.mock('@/lib/channels/notify-mentioned-users', () => ({ notifyMentionedUsers: vi.fn() }));

vi.mock('@/lib/websocket/conversation-events', () => ({
  SERVER_TRIGGERED_BROWSER_SESSION: 'server',
  conversationEvents: {
    messageCreated: vi.fn().mockResolvedValue(undefined),
    messageUpdated: vi.fn().mockResolvedValue(undefined),
    messageDeleted: vi.fn().mockResolvedValue(undefined),
    undoApplied: vi.fn().mockResolvedValue(undefined),
    created: vi.fn().mockResolvedValue(undefined),
    updated: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastAiMessageEdited: vi.fn().mockResolvedValue(undefined),
  broadcastAiMessageDeleted: vi.fn().mockResolvedValue(undefined),
  broadcastAiUndoApplied: vi.fn().mockResolvedValue(undefined),
}));



vi.mock('@/lib/repositories/global-conversation-repository', () => ({
  globalConversationRepository: {
    getMessageById: vi.fn().mockResolvedValue(null),
    recomputeLastMessageAt: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/repositories/conversation-rev', () => ({
  bumpConversationRev: vi.fn().mockResolvedValue({
    id: 'conv-1',
    userId: 'owner-1',
    title: null,
    type: 'page',
    contextId: 'page-1',
    sessionId: null,
    isShared: false,
    rev: 2,
    lastMessageAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }),
  emitContextFromRow: (row: { id: string }) => ({
    conversationId: row.id,
    rev: 2,
    scope: { kind: 'page', pageId: 'page-1' },
    workspaceId: null,
    ownerId: 'owner-1',
    isShared: false,
    triggeredBy: { userId: 'owner-1', browserSessionId: 'server' },
  }),
}));

import { messageRepository } from '../message-repository';

const LEGACY_LEG = 'chat_messages';
const UNIFIED_LEG = 'messages';

const writeOps = new Set(['insert', 'update', 'delete']);
const writtenTables = () =>
  new Set(touches.filter((t) => writeOps.has(t.op)).map((t) => t.table));

/** Every write recorded must sit between a begin and a commit. */
const allWritesWereTransactional = () => {
  let depth = 0;
  let ok = true;
  for (const touch of touches) {
    if (touch.op === 'begin') depth++;
    else if (touch.op === 'commit') depth--;
    else if (writeOps.has(touch.op) && depth === 0) ok = false;
  }
  return ok;
};

// ---------------------------------------------------------------------------
// PART 1 — behavioural: every page write path touches both legs.
// ---------------------------------------------------------------------------

/**
 * Every write path on the repository, page and global alike. Both kinds now
 * write ONE table — `messages` — which is the whole content of PR 14: the page
 * paths lost their `chat_messages` statement, the global paths never had one.
 */
const writePaths: Array<{ name: string; scope: 'page' | 'global'; run: () => Promise<unknown> }> = [
  {
    name: 'savePageMessage',
    scope: 'page',
    run: () =>
      messageRepository.savePageMessage({
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
        userId: 'user-1',
        role: 'user',
        content: 'hello',
      }),
  },
  {
    name: 'insertPageStreamingPlaceholder',
    scope: 'page',
    run: () =>
      messageRepository.insertPageStreamingPlaceholder({
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
      }),
  },
  {
    name: 'materializePageInterruptedMessage',
    scope: 'page',
    run: () =>
      messageRepository.materializePageInterruptedMessage({
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
        structuredContent: 'partial',
        toolCallsJson: null,
        toolResultsJson: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
  },
  {
    name: 'editPageMessage',
    scope: 'page',
    run: () =>
      messageRepository.editPageMessage({
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
        updatedContent: 'edited',
        legacyTriggeredBy: { userId: 'user-1', browserSessionId: 'b1', displayName: 'Tester' },
      }),
  },
  {
    name: 'softDeletePageMessage',
    scope: 'page',
    run: () =>
      messageRepository.softDeletePageMessage({
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
        legacyTriggeredBy: { userId: 'user-1', browserSessionId: 'b1', displayName: 'Tester' },
      }),
  },
  {
    name: 'saveGlobalMessage',
    scope: 'global',
    run: () =>
      messageRepository.saveGlobalMessage({
        messageId: 'msg-1',
        conversationId: 'conv-1',
        userId: 'user-1',
        role: 'user',
        content: 'hello',
      }),
  },
  {
    name: 'insertGlobalStreamingPlaceholder',
    scope: 'global',
    run: () =>
      messageRepository.insertGlobalStreamingPlaceholder({
        messageId: 'msg-1',
        conversationId: 'conv-1',
        userId: 'user-1',
      }),
  },
  {
    name: 'materializeGlobalInterruptedMessage',
    scope: 'global',
    run: () =>
      messageRepository.materializeGlobalInterruptedMessage({
        messageId: 'msg-1',
        conversationId: 'conv-1',
        userId: 'user-1',
        structuredContent: 'partial',
        toolCallsJson: null,
        toolResultsJson: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
  },
  {
    name: 'editGlobalMessage',
    scope: 'global',
    run: () =>
      messageRepository.editGlobalMessage({
        messageId: 'msg-1',
        conversationId: 'conv-1',
        ownerUserId: 'user-1',
        updatedContent: 'edited',
        legacyTriggeredBy: { userId: 'user-1', browserSessionId: 'b1', displayName: 'Tester' },
      }),
  },
  {
    name: 'softDeleteGlobalMessage',
    scope: 'global',
    run: () =>
      messageRepository.softDeleteGlobalMessage({
        messageId: 'msg-1',
        conversationId: 'conv-1',
        ownerUserId: 'user-1',
        legacyTriggeredBy: { userId: 'user-1', browserSessionId: 'b1', displayName: 'Tester' },
      }),
  },
];

/** Writes no message row at all — only the conversation rev + emissions. */
const nonMessageWritePaths = [
  'recordUndoApplied',
  // A message write, but a single-column one that predates the save methods
  // and is pinned directly by message-repository-update-tool-results.test.ts.
  'updateMessageToolResults',
  // Message-table housekeeping absorbed from `global-conversation-repository`
  // (Phase 4 PR 12). These DELETE/derive rather than persist a message:
  // `purgeInactiveMessages` sweeps the unified table, `recomputeLastMessageAt`
  // writes `conversations`, and `purgeInactiveLegacyChatMessages` is the ONE
  // method here that still names `chat_messages` — a DELETE, on the frozen
  // table, which retention still owes the user until PR 15 drops it.
  // Pinned by message-repository-last-message-recompute.test.ts.
  'purgeInactiveMessages',
  'purgeInactiveLegacyChatMessages',
  'recomputeLastMessageAt',
];

/**
 * READ seams on the repository — nothing to freeze, by construction. They are
 * enumerated anyway so the closed classification below stays closed: a new
 * method has to be declared a writer or a reader, never left unclassified.
 * Each is pinned against its frozen legacy query in
 * `unified-reader-parity.integration.test.ts`.
 */
const readPaths = [
  'getMessagesByConversationId',
  'getMessagesForPage',
  'getPageConversationMessages',
  'getRecentPageMessages',
  'getMessageById',
  'getMessageInConversation',
];

describe('message writes — behavioural freeze guard', () => {
  beforeEach(() => {
    touches.length = 0;
  });

  for (const path of writePaths) {
    it(`${path.name} writes the unified table and never touches chat_messages`, async () => {
      await path.run();
      const tables = writtenTables();
      expect(tables.has(UNIFIED_LEG)).toBe(true);
      expect(tables.has(LEGACY_LEG)).toBe(false);
      expect(allWritesWereTransactional()).toBe(true);
    });
  }

  it('classifies every method on the repository — a new write path must be added here', () => {
    const classified = new Set([
      ...writePaths.map((p) => p.name),
      ...nonMessageWritePaths,
      ...readPaths,
    ]);
    const actual = Object.keys(messageRepository).sort();
    expect(actual).toEqual([...classified].sort());
  });

  it('still covers both scopes — a deleted page path must not pass as "all green"', () => {
    expect(writePaths.filter((p) => p.scope === 'page')).toHaveLength(5);
    expect(writePaths.filter((p) => p.scope === 'global')).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// PART 2 — structural: nothing writes the legacy table; removals are listed.
// ---------------------------------------------------------------------------

/**
 * Files permitted to DELETE from `chat_messages`. There is no equivalent list
 * for INSERT/UPDATE — that list must be empty, and the assertion below says so
 * with no allowlist to add yourself to.
 *
 * A removal is not a write in the sense this guard polices: it cannot create a
 * row a reader will never see, and every entry here is an obligation that
 * outlives the freeze (retention, erasure, teardown) and dies with the table
 * at PR 15.
 */
const LEGACY_DELETE_ALLOWLIST: Array<{ file: string; why: string }> = [
  {
    file: 'src/lib/repositories/message-repository.ts',
    why: '`purgeInactiveLegacyChatMessages` — retention still owes the user the removal of soft-deleted legacy rows while they physically exist. Compliance-critical; PR 15 deletes it with the table.',
  },
  {
    file: 'src/app/api/trash/[pageId]/route.ts',
    why: "Permanent page delete. The frozen rows a page still holds must go with it (belt and braces alongside `chat_messages.pageId`'s ON DELETE CASCADE to `pages`).",
  },
];

/**
 * apps/web, resolved from the vitest root. `import.meta.url` is not a `file:`
 * URL under this app's vitest transform, so cwd is the reliable anchor — and
 * it is asserted below rather than assumed, so a config change that moves the
 * root fails loudly instead of silently scanning zero files and passing.
 */
const WEB_ROOT = process.cwd();
const LEGACY_CONTENT_WRITE = /\.(insert|update)\(\s*chatMessages\s*\)/;
const LEGACY_DELETE = /\.delete\(\s*chatMessages\s*\)/;
const UNIFIED_WRITE = /\.(insert|update|delete)\(\s*messages\s*\)/;

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTsFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('message writes — structural freeze guard', () => {
  const sources = walkTsFiles(join(WEB_ROOT, 'src')).map((file) => ({
    // POSIX-normalised so the allowlist reads the same on any platform.
    rel: relative(WEB_ROOT, file).split(sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }));

  const matching = (pattern: RegExp) =>
    sources.filter((source) => pattern.test(source.text)).map((source) => source.rel).sort();

  it('actually scanned the app source (a mis-resolved root would pass everything)', () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources.some((s) => s.rel === 'src/lib/repositories/message-repository.ts')).toBe(true);
    // The scan must also be able to SEE a write — a regex or path regression
    // that matches nothing anywhere would make every assertion below vacuous.
    expect(matching(UNIFIED_WRITE).length).toBeGreaterThan(0);
    expect(matching(LEGACY_DELETE).length).toBeGreaterThan(0);
  });

  it('NOTHING inserts or updates chat_messages — the legacy leg is frozen', () => {
    // No allowlist, deliberately. If this fails, the fix is to delete the
    // write, not to add the file here: a row written to `chat_messages` is
    // invisible to every reader (they have all read `messages` since PR 12)
    // and blocks PR 15 from dropping the table.
    expect(matching(LEGACY_CONTENT_WRITE)).toEqual([]);
  });

  it('only the listed removal sweeps delete from chat_messages', () => {
    expect(matching(LEGACY_DELETE)).toEqual(LEGACY_DELETE_ALLOWLIST.map((e) => e.file).sort());
  });

  it('the unified table has a known, small set of writer modules', () => {
    expect(matching(UNIFIED_WRITE)).toEqual(
      [
        // The shared page-message writer used by the repository and by the
        // History-delete cascade.
        'src/lib/repositories/unified-message-leg.ts',
        // The message repository: the global assistant's own writes, plus the
        // purge and the lastMessageAt recompute (Phase 4 PR 12).
        'src/lib/repositories/message-repository.ts',
        // Page teardown and undo — range/sweep writers rather than row-level
        // content writes, which is why they are not routed through the shared
        // writer (it writes one row at a time).
        'src/app/api/trash/[pageId]/route.ts',
        'src/services/api/ai-undo-service.ts',
      ].sort(),
    );
  });

  it('the shared page writer is what the cascade uses, not a hand-rolled statement', () => {
    const cascade = sources.find((s) => s.rel === 'src/lib/repositories/conversation-repository.ts');
    expect(cascade, 'conversation-repository.ts no longer exists').toBeDefined();
    expect(cascade!.text).toContain('unified-message-leg');
    expect(UNIFIED_WRITE.test(cascade!.text)).toBe(false);
  });

  it('the dual-write kill switch is gone with the leg it switched off', () => {
    // A kill switch for a leg that no longer exists is a lie: it would read as
    // "the legacy leg can be restored by an env var", and nothing would happen.
    expect(matching(/UNIFIED_MESSAGES_DUAL_WRITE/)).toEqual([]);
    expect(matching(/isUnifiedMessageDualWriteEnabled/)).toEqual([]);
  });
});
