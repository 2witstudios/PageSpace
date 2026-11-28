/**
 * The org audit outbox (Spec AUD-1, AUD-2) against a real Postgres: an org event is staged in the transaction of its
 * change, published after commit, and anything the chain refuses stays queued until the drainer delivers it. The
 * chain append itself is captured (and can be refused) so each test controls it.
 *
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/audit/__tests__/org-audit-outbox.integration.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { orgAuditOutbox } from '@pagespace/db/schema/organizations';
import { users } from '@pagespace/db/schema/auth';
import { factories } from '@pagespace/db/test/factories';
import type { AuditEvent } from '../security-audit';

const chain = vi.hoisted(() => ({ appended: [] as AuditEvent[], refuse: 0 }));
vi.mock('../security-audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../security-audit')>();
  return {
    ...actual,
    securityAudit: {
      ...actual.securityAudit,
      logEvent: vi.fn(async (entry: AuditEvent) => {
        if (chain.refuse > 0) {
          chain.refuse -= 1;
          throw new Error('audit chain unavailable');
        }
        chain.appended.push(entry);
      }),
    },
  };
});

import {
  discardStagedOrgAuditEvents,
  drainOrgAuditOutbox,
  getOrgAuditBacklog,
  publishOrgAuditEvents,
  stageOrgAuditEvent,
  transactionWithOrgAudit,
  type OrgAuditEvent,
} from '../org-audit';
import { ORG_AUDIT_DEAD_LETTER_ATTEMPTS, ORG_AUDIT_RETRY_BASE_MS, ORG_AUDIT_PENDING_HOLD_MS } from '../org-audit-outbox-core';

const orgId = `org_${createId()}`;
let actorId = '';
const event = (over: Partial<OrgAuditEvent> = {}): OrgAuditEvent => ({
  orgId,
  eventType: 'org.policy.changed',
  actorId,
  resourceType: 'organization',
  resourceId: orgId,
  details: { changes: [] },
  ...over,
});
const outboxRows = () => db.select().from(orgAuditOutbox).where(eq(orgAuditOutbox.orgId, orgId));
const mine = () => chain.appended.filter((e) => e.details?.orgId === orgId);

beforeAll(async () => {
  actorId = (await factories.createUser()).id;
});

beforeEach(async () => {
  chain.appended.length = 0;
  chain.refuse = 0;
  await db.delete(orgAuditOutbox).where(eq(orgAuditOutbox.orgId, orgId));
});

afterAll(async () => {
  await db.delete(orgAuditOutbox).where(eq(orgAuditOutbox.orgId, orgId));
  await db.delete(users).where(eq(users.id, actorId));
  const { pool } = await import('@pagespace/db/db');
  await pool.end();
});

describe('the org audit outbox', () => {
  it('AUD-2 (partial) a published event is one chain row with the org (and drive) as dimensions no caller detail can overwrite', async () => {
    await transactionWithOrgAudit((_tx, audit) => audit(event({ driveId: 'drive_1', details: { orgId: 'org_evil', driveId: 'd_evil', n: 1 } })));
    expect(mine()).toEqual([{
      eventType: 'org.policy.changed',
      userId: actorId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { n: 1, orgId, driveId: 'drive_1', occurredAt: expect.any(String), outboxId: expect.any(String) },
    }]);
    expect(await outboxRows()).toEqual([]);
  });

  it('AUD-1 (partial) an event staged in a change that rolls back never exists, so a rolled-back change is never audited', async () => {
    await expect(transactionWithOrgAudit(async (_tx, audit) => {
      await audit(event());
      throw new Error('the change failed');
    })).rejects.toThrow('the change failed');
    expect(await outboxRows()).toEqual([]);
    expect(mine()).toEqual([]);
  });

  it('AUD-1 (partial) a refused append is never lost: it stays queued with a backoff, the drainer leaves it until due, then delivers it once', async () => {
    chain.refuse = 1;
    await transactionWithOrgAudit((_tx, audit) => audit(event()));
    const [queued] = await outboxRows();
    expect(queued).toMatchObject({ attempts: 1, lastError: 'audit chain unavailable' });
    expect(queued.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + ORG_AUDIT_RETRY_BASE_MS / 2);
    expect(mine()).toEqual([]);

    await drainOrgAuditOutbox({ now: new Date() });
    expect(mine()).toEqual([]);

    const due = new Date(queued.nextAttemptAt.getTime() + 1000);
    expect(await drainOrgAuditOutbox({ now: due })).toMatchObject({ delivered: expect.any(Number) });
    expect(mine().map((e) => e.eventType)).toEqual(['org.policy.changed']);
    expect(await outboxRows()).toEqual([]);
    await drainOrgAuditOutbox({ now: due });
    expect(mine()).toHaveLength(1);
  });

  it('AUD-1 (partial) a refused retry backs off further and keeps the event; nothing ever drops it', async () => {
    chain.refuse = 3;
    await transactionWithOrgAudit((_tx, audit) => audit(event()));
    const far = new Date(Date.now() + 24 * 60 * 60_000);
    await drainOrgAuditOutbox({ now: far });
    await drainOrgAuditOutbox({ now: new Date(far.getTime() + 24 * 60 * 60_000) });
    const [queued] = await outboxRows();
    expect(queued.attempts).toBe(3);
    await drainOrgAuditOutbox({ now: new Date(far.getTime() + 48 * 60 * 60_000) });
    expect(mine()).toHaveLength(1);
    expect(await outboxRows()).toEqual([]);
  });

  it('AUD-1 (partial) an event of a change that is not final yet is held from the drainer, published once final, or discarded with an undo', async () => {
    const kept = await db.transaction((tx) => stageOrgAuditEvent(tx, event({ eventType: 'org.invite.created' }), { held: true }));
    const undone = await db.transaction((tx) => stageOrgAuditEvent(tx, event({ eventType: 'org.invite.resent' }), { held: true }));
    await drainOrgAuditOutbox({ now: new Date(Date.now() + ORG_AUDIT_PENDING_HOLD_MS / 2) });
    expect(mine()).toEqual([]);

    await publishOrgAuditEvents(kept);
    await db.transaction((tx) => discardStagedOrgAuditEvents(tx, [undone]));
    expect(mine().map((e) => e.eventType)).toEqual(['org.invite.created']);
    expect(await outboxRows()).toEqual([]);
  });

  it('AUD-1 (partial) an event whose actor deleted their account while it waited is still delivered, naming no one (as erasure leaves a delivered row)', async () => {
    const gone = await factories.createUser();
    chain.refuse = 1;
    await transactionWithOrgAudit((_tx, audit) => audit(event({ actorId: gone.id })));
    await db.delete(users).where(eq(users.id, gone.id));
    await drainOrgAuditOutbox({ now: new Date(Date.now() + 2 * 60 * 60_000) });
    expect(mine().map((e) => e.userId)).toEqual([undefined]);
    expect(await outboxRows()).toEqual([]);
  });

  it('AUD-1 (partial) a delayed event is dated by its change, not its delivery, and carries the outbox id a reader deduplicates on', async () => {
    chain.refuse = 1;
    const before = Date.now();
    const [staged] = await transactionWithOrgAudit(async (tx, audit) => {
      await audit(event());
      return tx.select({ id: orgAuditOutbox.id }).from(orgAuditOutbox).where(eq(orgAuditOutbox.orgId, orgId));
    });
    await drainOrgAuditOutbox({ now: new Date(Date.now() + 2 * 60 * 60_000) });
    const [delivered] = mine();
    expect(delivered.details?.outboxId).toBe(staged.id);
    const occurredAt = new Date(String(delivered.details?.occurredAt)).getTime();
    expect(occurredAt).toBeGreaterThanOrEqual(before - 1000);
    expect(occurredAt).toBeLessThanOrEqual(Date.now());
  });

  it('AUD-1 (partial) an event the chain refuses on every attempt is dead-lettered: kept, counted for admins, no longer retried', async () => {
    chain.refuse = ORG_AUDIT_DEAD_LETTER_ATTEMPTS + 5;
    await transactionWithOrgAudit((_tx, audit) => audit(event()));
    let at = Date.now();
    let deadLettered = 0;
    for (let pass = 1; pass < ORG_AUDIT_DEAD_LETTER_ATTEMPTS + 3; pass += 1) {
      at += 2 * 60 * 60_000;
      deadLettered += (await drainOrgAuditOutbox({ now: new Date(at) })).deadLettered;
    }
    const [row] = await outboxRows();
    expect(row.attempts).toBe(ORG_AUDIT_DEAD_LETTER_ATTEMPTS);
    expect(row.deadLetteredAt).not.toBeNull();
    expect(deadLettered).toBe(1);
    expect((await getOrgAuditBacklog()).deadLettered).toBeGreaterThanOrEqual(1);
    expect(mine()).toEqual([]);
  });

  it('AUD-1 (partial) a held event whose change committed but whose caller stopped before publishing (a crash after the email went out) is delivered by the drainer when the hold ends', async () => {
    await db.transaction((tx) => stageOrgAuditEvent(tx, event({ eventType: 'org.guest.approved', details: { emailed: true } }), { held: true }));
    // No publish, no discard: the process stopped between the email and the publish.
    expect(await drainOrgAuditOutbox({ now: new Date(Date.now() + ORG_AUDIT_PENDING_HOLD_MS / 2) })).toMatchObject({ delivered: 0 });
    expect(await drainOrgAuditOutbox({ now: new Date(Date.now() + ORG_AUDIT_PENDING_HOLD_MS + 60_000) })).toMatchObject({ delivered: 1 });
    expect(mine().map((e) => e.details?.emailed)).toEqual([true]);
  });

  it('AUD-1 (partial) a publish and the drainer racing for the same events deliver each exactly once', async () => {
    const staged = await db.transaction(async (tx) => Promise.all([1, 2, 3, 4, 5].map((n) => stageOrgAuditEvent(tx, event({ details: { n } })))));
    await Promise.all([publishOrgAuditEvents(staged), drainOrgAuditOutbox(), drainOrgAuditOutbox()]);
    expect(mine().map((e) => e.details?.n).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(await db.select().from(orgAuditOutbox).where(inArray(orgAuditOutbox.id, staged.map((s) => s.id)))).toEqual([]);
  });
});
