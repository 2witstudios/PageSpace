/**
 * DRIFT GUARD for the chat_messages → messages dual-write (epic
 * "Agent-Session Single Source of Truth", Phase 4 / D6; epic #2161's rule
 * that a forced copy gets a drift-guard test AND a reconciler).
 *
 * The brief for this suite is blunt: A WRITE THAT UPDATES ONLY ONE LEG MUST
 * FAIL THIS SUITE. It gets there two ways, because one way cannot cover both
 * failure modes:
 *
 *   PART 1 — BEHAVIOURAL. Every page write path on `messageRepository` is
 *   driven against a recording fake `db` and asserted to touch BOTH
 *   `chat_messages` and `messages`, IN THE SAME TRANSACTION. Deleting the
 *   unified leg from any of them turns the suite red. The enumeration is
 *   closed: an unclassified new method on the repository also fails, so a
 *   future write path cannot be added without deciding which leg(s) it needs.
 *
 *   PART 2 — STRUCTURAL. Part 1 only knows about writers it enumerates, and
 *   the failure mode that actually loses data is a writer nobody remembered
 *   to enumerate. So the source tree is scanned for every statement that
 *   writes `chatMessages` and the owning files are held to an allowlist —
 *   each entry either routes through the shared unified-leg writer, or is
 *   recorded here with the reason it does not.
 *
 * The runtime counterpart (do the ROWS agree?) is the
 * `reconcile-message-unification` cron; see
 * `@/lib/repositories/message-unification-reconcile`.
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

vi.mock('@/lib/repositories/chat-message-repository', () => ({
  chatMessageRepository: { getMessageById: vi.fn().mockResolvedValue(null) },
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

const pageWritePaths: Array<{ name: string; run: () => Promise<unknown> }> = [
  {
    name: 'savePageMessage',
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
    run: () =>
      messageRepository.insertPageStreamingPlaceholder({
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
      }),
  },
  {
    name: 'materializePageInterruptedMessage',
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
    run: () =>
      messageRepository.softDeletePageMessage({
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
        legacyTriggeredBy: { userId: 'user-1', browserSessionId: 'b1', displayName: 'Tester' },
      }),
  },
];

/**
 * Global paths are SINGLE-leg by design and must stay that way: `messages` has
 * always been the global assistant's own table, so a global write that also
 * touched `chat_messages` would be inventing page rows.
 */
const globalWritePaths: Array<{ name: string; run: () => Promise<unknown> }> = [
  {
    name: 'saveGlobalMessage',
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
    run: () =>
      messageRepository.insertGlobalStreamingPlaceholder({
        messageId: 'msg-1',
        conversationId: 'conv-1',
        userId: 'user-1',
      }),
  },
  {
    name: 'materializeGlobalInterruptedMessage',
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
const nonMessageWritePaths = ['recordUndoApplied'];

describe('unified message dual-write — behavioural drift guard', () => {
  beforeEach(() => {
    touches.length = 0;
    vi.stubEnv('UNIFIED_MESSAGES_DUAL_WRITE', '');
  });

  for (const path of pageWritePaths) {
    it(`${path.name} writes BOTH legs in one transaction`, async () => {
      await path.run();
      const tables = writtenTables();
      expect(tables.has(LEGACY_LEG)).toBe(true);
      expect(tables.has(UNIFIED_LEG)).toBe(true);
      expect(allWritesWereTransactional()).toBe(true);
    });
  }

  for (const path of globalWritePaths) {
    it(`${path.name} writes the unified table only (it has no legacy leg)`, async () => {
      await path.run();
      const tables = writtenTables();
      expect(tables.has(UNIFIED_LEG)).toBe(true);
      expect(tables.has(LEGACY_LEG)).toBe(false);
    });
  }

  it('the kill switch disables the unified leg and nothing else', async () => {
    vi.stubEnv('UNIFIED_MESSAGES_DUAL_WRITE', 'off');
    await messageRepository.savePageMessage({
      messageId: 'msg-1',
      pageId: 'page-1',
      conversationId: 'conv-1',
      userId: 'user-1',
      role: 'user',
      content: 'hello',
    });
    const tables = writtenTables();
    expect(tables.has(LEGACY_LEG)).toBe(true);
    expect(tables.has(UNIFIED_LEG)).toBe(false);
  });

  it('classifies every method on the repository — a new write path must be added here', () => {
    const classified = new Set([
      ...pageWritePaths.map((p) => p.name),
      ...globalWritePaths.map((p) => p.name),
      ...nonMessageWritePaths,
    ]);
    const actual = Object.keys(messageRepository).sort();
    expect(actual).toEqual([...classified].sort());
  });
});

// ---------------------------------------------------------------------------
// PART 2 — structural: nothing writes the legacy leg outside the allowlist.
// ---------------------------------------------------------------------------

/**
 * Files permitted to issue a `chat_messages` write statement. Everything with
 * `dualWrites: true` must also import the shared unified-leg writer — that
 * pairing is the assertion. The `false` entries carry their exemption reason
 * in `why`, so removing a leg can never be argued for silently.
 */
const LEGACY_WRITE_ALLOWLIST: Array<{ file: string; dualWrites: boolean; why?: string }> = [
  { file: 'src/lib/repositories/message-repository.ts', dualWrites: true },
  { file: 'src/lib/repositories/conversation-repository.ts', dualWrites: true },
  { file: 'src/lib/repositories/chat-message-repository.ts', dualWrites: true },
  {
    file: 'src/app/api/trash/[pageId]/route.ts',
    dualWrites: false,
    why: 'Hard delete of a purged page. Deletion paths are Phase 4 PR 13/15 (compliance + contract); until then `messages` rows are cleared by their own FK cascade on conversations.',
  },
  {
    file: 'src/app/api/debug/chat-messages/route.ts',
    dualWrites: false,
    why: 'Non-production debug seeding route; it fabricates fixture rows and is not a user-reachable write path.',
  },
];

/**
 * apps/web, resolved from the vitest root. `import.meta.url` is not a `file:`
 * URL under this app's vitest transform, so cwd is the reliable anchor — and
 * it is asserted below rather than assumed, so a config change that moves the
 * root fails loudly instead of silently scanning zero files and passing.
 */
const WEB_ROOT = process.cwd();
const LEGACY_WRITE_PATTERN = /\.(insert|update|delete)\(\s*chatMessages\s*\)/;
const UNIFIED_LEG_IMPORT = 'unified-message-leg';

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTsFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('unified message dual-write — structural drift guard', () => {
  const sources = walkTsFiles(join(WEB_ROOT, 'src')).map((file) => ({
    // POSIX-normalised so the allowlist reads the same on any platform.
    rel: relative(WEB_ROOT, file).split(sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }));

  const legacyWriters = sources
    .filter((source) => LEGACY_WRITE_PATTERN.test(source.text))
    .map((source) => source.rel)
    .sort();

  it('actually scanned the app source (a mis-resolved root would pass everything)', () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources.some((s) => s.rel === 'src/lib/repositories/message-repository.ts')).toBe(true);
  });

  it('no file writes chat_messages without being classified here', () => {
    expect(legacyWriters).toEqual(LEGACY_WRITE_ALLOWLIST.map((e) => e.file).sort());
  });

  for (const entry of LEGACY_WRITE_ALLOWLIST.filter((e) => e.dualWrites)) {
    it(`${entry.file} routes its writes through the shared unified-leg writer`, () => {
      const source = sources.find((s) => s.rel === entry.file);
      expect(source, `${entry.file} is allowlisted but no longer exists`).toBeDefined();
      expect(source!.text).toContain(UNIFIED_LEG_IMPORT);
    });
  }

  it('the unified leg has exactly one writer module', () => {
    const unifiedWriters = sources
      .filter((source) => /\.(insert|update|delete)\(\s*messages\s*\)/.test(source.text))
      .map((source) => source.rel)
      .sort();
    expect(unifiedWriters).toEqual(
      [
        // The one shared unified-leg writer used by every dual-writing path.
        'src/lib/repositories/unified-message-leg.ts',
        // The global assistant's own leg: `messages` IS its legacy table, so
        // its statements live with the rest of the message writer.
        'src/lib/repositories/message-repository.ts',
        // Global conversation lifecycle (recompute/purge/hard-delete) — the
        // global side of the table, untouched by the page-chat merge.
        'src/lib/repositories/global-conversation-repository.ts',
      ].sort(),
    );
  });
});
