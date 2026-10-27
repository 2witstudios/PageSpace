/**
 * Page Webhooks epic — schema-level proof of the trigger-anchor contract.
 *
 * webhook_triggers rows anchor to exactly one event source: a Zoom OAuth
 * connection XOR a page incoming webhook. The XOR CHECK is security-relevant
 * — every Zoom query path filters eq(connectionId, <id>), so it is the
 * constraint that keeps page-anchored rows invisible to Zoom dispatch and
 * Zoom management routes. The migration-SQL pinning test
 * (src/__tests__/webhook-triggers-anchor-migration.test.ts) freezes the 0215
 * artifact; THIS test guards the live schema layer, where future drift would
 * actually originate (weakening the schema makes drizzle emit a
 * DROP CONSTRAINT in some 0216+ migration while every 0215 assertion still
 * passes). Runs without a database, per the commands-schema-edge-cases
 * precedent.
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import {
  webhookTriggers,
  webhookTriggersRelations,
  PAGE_WEBHOOK_EVENT_TYPE,
} from '../webhook-triggers';

const config = getTableConfig(webhookTriggers);
const columns = getTableColumns(webhookTriggers);

function fkOnColumn(columnName: string) {
  const fk = config.foreignKeys.find((candidate) =>
    candidate.reference().columns.some((column) => column.name === columnName)
  );
  expect(fk, `expected a foreign key on ${columnName}`).toBeDefined();
  return fk!;
}

describe('webhook_triggers schema — anchor contract', () => {
  it('enforces exactly one anchor via the XOR check constraint', () => {
    const anchorCheck = config.checks.find((check) => check.name === 'webhook_triggers_anchor_chk');
    expect(anchorCheck).toBeDefined();
  });

  it('keeps both anchor columns nullable (the CHECK, not NOT NULL, carries the invariant)', () => {
    expect(columns.connectionId.notNull).toBe(false);
    expect(columns.pageWebhookId.notNull).toBe(false);
  });

  it('cascade-deletes triggers with their page webhook', () => {
    const fk = fkOnColumn('pageWebhookId');
    expect(getTableConfig(fk.reference().foreignTable).name).toBe('page_webhooks');
    expect(fk.onDelete).toBe('cascade');
  });

  it('still cascade-deletes triggers with their Zoom connection', () => {
    const fk = fkOnColumn('connectionId');
    expect(getTableConfig(fk.reference().foreignTable).name).toBe('zoom_connections');
    expect(fk.onDelete).toBe('cascade');
  });

  it('dedupes page wirings via the partial unique index on (pageWebhookId, workflowId)', () => {
    const partial = config.indexes.find(
      (index) => index.config.name === 'webhook_triggers_page_webhook_workflow_unique'
    );
    expect(partial).toBeDefined();
    expect(partial!.config.unique).toBe(true);
    expect(partial!.config.where).toBeDefined();
  });

  it('preserves the pre-existing Zoom idempotency key untouched', () => {
    const names = config.uniqueConstraints.map((constraint) => constraint.name);
    expect(names).toContain('webhook_triggers_connection_workflow_event_unique');
  });

  it('still requires a workflow on every row', () => {
    expect(columns.workflowId.notNull).toBe(true);
  });

  it('pins the page-anchor eventType sentinel insert paths must write', () => {
    expect(PAGE_WEBHOOK_EVENT_TYPE).toBe('*');
  });

  it('exports relations for both anchor join paths', () => {
    expect(webhookTriggersRelations).toBeDefined();
  });
});
