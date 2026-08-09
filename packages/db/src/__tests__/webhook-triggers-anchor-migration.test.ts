/**
 * Static invariants of the webhook_triggers anchor-generalization migration
 * (0215, Page Webhooks epic).
 *
 * webhook_triggers is a LIVE-TRAFFIC table (Zoom trigger wiring). 0215 must
 * stay strictly additive — nullable-ize connectionId, add the pageWebhookId
 * anchor, and enforce exactly-one-anchor via CHECK — without ever rewriting
 * or dropping existing Zoom rows/columns. The XOR CHECK is security-relevant:
 * it is what keeps page-anchored rows invisible to every Zoom query path
 * (all of which filter eq(connectionId, <id>)). These tests pin the migration
 * SQL so CI catches a regressed or regenerated migration without a database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

const migrationFile = readdirSync(MIGRATIONS_DIR).find((f) => /^0215_.*\.sql$/.test(f));
const sql = readFileSync(path.join(MIGRATIONS_DIR, migrationFile ?? ''), 'utf8');
/** SQL with line comments stripped, so assertions never match prose. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('drizzle/0215 webhook_triggers anchor generalization', () => {
  it('should exist in the journal as migration 0215', () => {
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 215)?.tag).toBe(
      path.basename(migrationFile ?? '', '.sql'),
    );
  });

  it('should nullable-ize connectionId and add pageWebhookId as a bare nullable column (no default, no rewrite)', () => {
    expect(code).toContain('ALTER TABLE "webhook_triggers" ALTER COLUMN "connectionId" DROP NOT NULL');
    expect(code).toContain('ALTER TABLE "webhook_triggers" ADD COLUMN "pageWebhookId" text;');
  });

  it('should cascade-delete triggers with their page webhook', () => {
    expect(code).toContain(
      'FOREIGN KEY ("pageWebhookId") REFERENCES "public"."page_webhooks"("id") ON DELETE cascade',
    );
  });

  it('should index the new anchor and enforce one wiring per (pageWebhookId, workflowId) via partial unique', () => {
    expect(code).toContain(
      'CREATE INDEX IF NOT EXISTS "webhook_triggers_page_webhook_id_idx" ON "webhook_triggers" USING btree ("pageWebhookId")',
    );
    expect(code).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "webhook_triggers_page_webhook_workflow_unique" ON "webhook_triggers" USING btree ("pageWebhookId","workflowId") WHERE "webhook_triggers"."pageWebhookId" IS NOT NULL',
    );
  });

  it('should enforce exactly one anchor via the XOR CHECK (idempotent, per the 0156 commands_scope_chk pattern)', () => {
    expect(code).toContain(`DO $$ BEGIN
  ALTER TABLE "webhook_triggers" ADD CONSTRAINT "webhook_triggers_anchor_chk" CHECK (
    ("connectionId" IS NOT NULL AND "pageWebhookId" IS NULL) OR ("connectionId" IS NULL AND "pageWebhookId" IS NOT NULL)
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;`);
  });

  it('should be strictly additive on the live table — no drops, renames, or data rewrites', () => {
    expect(code).not.toContain('DROP COLUMN');
    expect(code).not.toContain('DROP TABLE');
    expect(code).not.toMatch(/\bRENAME\b/);
    expect(code).not.toMatch(/^\s*(UPDATE|DELETE FROM|TRUNCATE)\b/m);
    // The pre-existing Zoom idempotency key must survive untouched.
    expect(code).not.toContain('webhook_triggers_connection_workflow_event_unique');
  });
});
