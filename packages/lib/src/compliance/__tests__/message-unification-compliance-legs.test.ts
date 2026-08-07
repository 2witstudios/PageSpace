/**
 * THE COMPLIANCE-LEG CONTRACT while `messages` and `chat_messages` coexist.
 *
 * Epic "Agent-Session Single Source of Truth", Phase 4 / D6, PR 13. Three
 * rules, deliberately asymmetric, each pinned here at the table level so a
 * well-meant "cleanup" cannot quietly break one:
 *
 *   1. GDPR EXPORT reads the UNIFIED table ONLY. After the dual-write and the
 *      backfill, `messages` is a SUPERSET of `chat_messages` under the SAME
 *      primary keys, so reading both exports every page-chat row twice.
 *   2. ERASURE and RETENTION keep BOTH LEGS until `chat_messages` is DROPPED.
 *      This is a legal requirement, not a style preference: while rows
 *      physically exist in that table, an Art 17 request and the retention
 *      window must both still reach them. A table no sweep names is a table
 *      whose personal data is retained forever.
 *   3. The legacy leg may be removed ONLY by Phase 4 PR 15, in the same change
 *      that runs `DROP TABLE chat_messages`.
 *
 * These are behavioural pins — the real functions run against a fake executor
 * that records which drizzle tables were touched — so they answer "what does
 * this code do to which table", not "does the source still contain a word".
 * The end-to-end proof over a real dual-written corpus (export completeness,
 * cascade coverage) lives in
 * `apps/web/src/lib/repositories/__tests__/unified-compliance-legs.integration.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { getTableName, type Table } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { cleanupSoftDeletedChatRecords } from '../retention/retention-engine';
import { collectUserMessages } from '../export/gdpr-export';

type DB = NodePgDatabase<Record<string, unknown>>;

const LEGACY_LEG = 'chat_messages';
const UNIFIED_LEG = 'messages';

/**
 * Cite-the-reason failure messages. A future reader who deletes the legacy
 * leg early sees WHY it is there and WHERE it is allowed to go, not just a
 * red assertion.
 */
const PR15_ONLY =
  `the LEGACY leg (${LEGACY_LEG}) must stay until Phase 4 PR 15 DROPs the table. ` +
  'Rows physically exist there, so a right-to-erasure request and the retention ' +
  'window must both still reach them. PR 15 — the only irreversible PR in the ' +
  'epic — is the one place this leg may be removed, together with the table itself.';

const EXPORT_IS_UNIFIED_ONLY =
  `the GDPR export must read the UNIFIED leg (${UNIFIED_LEG}) ONLY. Since the ` +
  `dual-write + backfill, ${UNIFIED_LEG} is a superset of ${LEGACY_LEG} under the ` +
  'SAME primary keys — reading both exports every page-chat message TWICE, which ' +
  'is a duplicate rather than extra coverage.';

/** Records the tables a DELETE statement targets; resolves every chain to []. */
function createDeleteRecorder() {
  const deletedFrom: string[] = [];
  const db = {
    delete(table: Table) {
      deletedFrom.push(getTableName(table));
      const chain = {
        where: () => chain,
        returning: async () => [],
      };
      return chain;
    },
  };
  return { db: db as unknown as DB, deletedFrom };
}

/**
 * Records the tables a SELECT reads. The chain object IS a promise, so every
 * `await database.select(...).from(x).where(y)` resolves to an empty result
 * whatever shape the query takes.
 */
function createSelectRecorder() {
  const readFrom: string[] = [];
  const joined: string[] = [];
  const chain = () => {
    const p = Promise.resolve([]) as Promise<never[]> & Record<string, unknown>;
    p.from = (table: Table) => {
      readFrom.push(getTableName(table));
      return p;
    };
    p.innerJoin = (table: Table) => {
      joined.push(getTableName(table));
      return p;
    };
    p.leftJoin = p.innerJoin;
    p.where = () => p;
    p.limit = () => p;
    p.orderBy = () => p;
    return p;
  };
  const db = { select: () => chain(), selectDistinct: () => chain() };
  return { db: db as unknown as DB, readFrom, joined };
}

describe('compliance legs while chat_messages and messages coexist (Phase 4 PR 13)', () => {
  describe('RETENTION — both legs, until PR 15', () => {
    it(`sweeps the LEGACY leg: ${PR15_ONLY}`, async () => {
      const { db, deletedFrom } = createDeleteRecorder();
      await cleanupSoftDeletedChatRecords(db);
      expect(deletedFrom).toContain(LEGACY_LEG);
    });

    it('sweeps the UNIFIED leg too — the two legs are swept independently, not one via the other', async () => {
      const { db, deletedFrom } = createDeleteRecorder();
      await cleanupSoftDeletedChatRecords(db);
      expect(deletedFrom).toContain(UNIFIED_LEG);
    });

    it('reports a row count for BOTH message tables, so a leg that stops working is visible in the cron output', async () => {
      const { db } = createDeleteRecorder();
      const results = await cleanupSoftDeletedChatRecords(db);
      const tables = results.map((r) => r.table);
      expect(tables).toContain(LEGACY_LEG);
      expect(tables).toContain(UNIFIED_LEG);
    });

    it('deletes conversations LAST — that statement cascades into both message legs and ai_stream_sessions (0248/0249), and running it alongside the direct sweeps can deadlock on the same rows', async () => {
      const { db, deletedFrom } = createDeleteRecorder();
      await cleanupSoftDeletedChatRecords(db);
      expect(deletedFrom.indexOf('conversations')).toBeGreaterThan(deletedFrom.indexOf(LEGACY_LEG));
      expect(deletedFrom.indexOf('conversations')).toBeGreaterThan(deletedFrom.indexOf(UNIFIED_LEG));
    });
  });

  describe('GDPR EXPORT — the unified leg only', () => {
    it(`reads ${UNIFIED_LEG}`, async () => {
      const { db, readFrom } = createSelectRecorder();
      await collectUserMessages(db, 'subject-1');
      expect(readFrom).toContain(UNIFIED_LEG);
    });

    it(`does NOT read ${LEGACY_LEG}: ${EXPORT_IS_UNIFIED_ONLY}`, async () => {
      const { db, readFrom } = createSelectRecorder();
      await collectUserMessages(db, 'subject-1');
      expect(readFrom).not.toContain(LEGACY_LEG);
    });

    it('joins conversations — an agent-authored row (userId NULL) is only reachable through its thread\'s owner, and without that join the export drops every assistant reply in the subject\'s own page chats', async () => {
      const { db, joined } = createSelectRecorder();
      await collectUserMessages(db, 'subject-1');
      expect(joined).toContain('conversations');
    });

    it('reads the unified leg exactly once — a second pass would re-export the same rows under a different source label', async () => {
      const { db, readFrom } = createSelectRecorder();
      await collectUserMessages(db, 'subject-1');
      expect(readFrom.filter((t) => t === UNIFIED_LEG)).toHaveLength(1);
    });
  });
});
