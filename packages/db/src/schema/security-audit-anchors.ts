/**
 * Security Audit Anchors — the receipt witness surface for the externally
 * anchored chain head (#890 Phase 2, leaf 3).
 *
 * TRUST-PLANE ONLY: this table exists exclusively in the Admin PG. It is
 * exported from src/admin-schema.ts (the drizzle-admin pipeline) and must
 * NEVER be added to the main schema barrel (src/schema.ts).
 *
 * After each anchor interval the chainer publishes a signed head statement
 * (packages/lib/src/audit/anchor.ts) to S3 Object-Lock AND persists it here
 * as a second, already-shipped witness surface (the siem_delivery_receipts
 * precedent — its delivery-attestation shape does not fit anchor records,
 * hence this sibling table). Grants make it append-only for EVERY role:
 * admin_chainer INSERT only, admin_reader SELECT only, nobody UPDATE/DELETE —
 * a compromised trust-plane credential can add anchors but never rewrite or
 * remove one.
 *
 * Columns mirror the SignedAnchor payload exactly (version/source semantics
 * live in the payload; `source` is a constant so it is not stored). Rows are
 * written by the receipt publisher via raw SQL (writeReceipts precedent), so
 * the cuid2 id is minted by the publisher, not $defaultFn.
 */

import { pgTable, text, timestamp, integer, bigint, index } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

export const securityAuditAnchors = pgTable('security_audit_anchors', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Anchor payload format version (ANCHOR_VERSION at publish time).
  version: integer('version').notNull(),

  // chain_seq of the anchored head row.
  chainSeq: bigint('chain_seq', { mode: 'number' }).notNull(),

  // event_hash of the anchored head row.
  headHash: text('head_hash').notNull(),

  // Anchor time — signed content, supplied by the publisher's clock.
  anchoredAt: timestamp('anchored_at', { withTimezone: true, mode: 'date' }).notNull(),

  // HMAC-SHA256 (hex) over the canonical anchor content.
  signature: text('signature').notNull(),

  // Receipt-row arrival time — forensics only, not signed content.
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  // The verifier matches anchors against chain rows by seq.
  chainSeqIdx: index('idx_security_audit_anchors_chain_seq').on(table.chainSeq),
}));

export type InsertSecurityAuditAnchor = typeof securityAuditAnchors.$inferInsert;
export type SelectSecurityAuditAnchor = typeof securityAuditAnchors.$inferSelect;
