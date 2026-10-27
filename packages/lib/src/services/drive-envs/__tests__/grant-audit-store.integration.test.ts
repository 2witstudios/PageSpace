/**
 * `drive_env_grant_audit` store — REAL Postgres (GA wave 3, leaf 1).
 *
 * The claim this file proves is the one `packages/cli/src/env-bridge/audit-log.ts`
 * makes: the daemon's JSONL and the server's rows are cross-referenceable by
 * `grantId` (invariant 10). A fake cannot prove a join; two real tables and a
 * fixture in the daemon's exact line shape can. Also pins what only the
 * database enforces: the CHECK that a refused row has no grant id and a
 * signed row has one, the partial unique index on `grantId`, and that a
 * second result for the same grant is a no-op.
 *
 * Runs in CI (the Unit Tests job provides Postgres). Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test -- src/services/drive-envs/__tests__/grant-audit-store.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { driveEnvLocal } from '@pagespace/db/schema/drive-env-local';
import { driveEnvGrantAudit, DRIVE_ENV_GRANT_AUDIT_SUMMARY_MAX_CHARS } from '@pagespace/db/schema/drive-env-grant-audit';
import { createDbGrantAuditStore, GRANT_AUDIT_SUMMARY_MAX_CHARS, type GrantAuditStore } from '../grant-audit-store';

const ownerId = createId();
const otherOwnerId = createId();
const driveId = createId();
const NOW = new Date('2026-09-09T12:00:00.000Z');
const principal = { userId: ownerId, sessionId: 'sess_1', conversationId: 'conv_1' };

let store: GrantAuditStore;
let envId: string;
let otherEnvId: string;

/** A LOCAL env with its sibling, owned by `owner`. */
async function seedLocalEnv(owner: string, name: string): Promise<string> {
  const id = createId();
  await db.insert(driveEnvs).values({ id, driveId, name, substrate: 'local', createdBy: owner, updatedAt: NOW });
  await db.insert(driveEnvLocal).values({ envId: id, ownerId: owner, label: name, enrollmentId: `enr_${id}`, serverPolicy: { ops: ['exec', 'fs_read'], checkpoint: false }, updatedAt: NOW });
  return id;
}

/**
 * ONE line exactly as the daemon's `formatAuditLine` writes it
 * (`packages/cli/src/env-bridge/audit-log.ts`): the field set and order are
 * the CLI's, copied here because lib cannot import the CLI. The CLI's own
 * test pins that shape; this one pins that the server side joins to it.
 */
function daemonJsonlLine(entry: { grantId: string | null; principal: typeof principal | null; op: string | null; verdict: string; argsHash: string | null; exitCode: number | null }, ts: number): string {
  return `${JSON.stringify({ ts: new Date(ts).toISOString(), grantId: entry.grantId, principal: entry.principal, op: entry.op, verdict: entry.verdict, argsHash: entry.argsHash, exitCode: entry.exitCode })}\n`;
}

beforeAll(async () => {
  store = await createDbGrantAuditStore();
  await db.insert(users).values([
    { id: ownerId, email: `audit-owner-${ownerId}@test.local`, name: 'Owner', updatedAt: NOW },
    { id: otherOwnerId, email: `audit-other-${otherOwnerId}@test.local`, name: 'Other', updatedAt: NOW },
  ]).onConflictDoNothing();
  await db.insert(drives).values({ id: driveId, name: 'Audit Drive', slug: `audit-drive-${driveId}`, ownerId, updatedAt: NOW }).onConflictDoNothing();
});

beforeEach(async () => {
  await db.delete(driveEnvs).where(eq(driveEnvs.driveId, driveId));
  envId = await seedLocalEnv(ownerId, `mine-${createId().slice(0, 6)}`);
  otherEnvId = await seedLocalEnv(otherOwnerId, `theirs-${createId().slice(0, 6)}`);
});

afterAll(async () => {
  await db.delete(driveEnvs).where(eq(driveEnvs.driveId, driveId));
  await db.delete(drives).where(eq(drives.id, driveId));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.delete(users).where(eq(users.id, otherOwnerId));
});

describe('the two sides join on grantId (invariant 10 — the claim audit-log.ts makes)', () => {
  it('given rows the server wrote at sign and result time and the daemon JSONL for the same grants, should join every signed row to exactly one line with the same op, argsHash and exit code', async () => {
    // The server's side: three grants signed, two answered, one still running.
    const a = await store.recordSign({ envId, grantId: 'grant_a', principal, op: 'exec', argsHash: 'hash_a', summary: 'exec: git status', now: NOW });
    const b = await store.recordSign({ envId, grantId: 'grant_b', principal, op: 'fs_read', argsHash: 'hash_b', summary: 'fs_read: /a', now: new Date(NOW.getTime() + 1000) });
    await store.recordSign({ envId, grantId: 'grant_c', principal, op: 'exec', argsHash: 'hash_c', summary: 'exec: sleep 30', now: new Date(NOW.getTime() + 2000) });
    await store.recordResult({ grantId: 'grant_a', verdict: 'completed', exitCode: 0, now: new Date(NOW.getTime() + 500) });
    await store.recordResult({ grantId: 'grant_b', verdict: 'denied:not_allowed', exitCode: null, now: new Date(NOW.getTime() + 1500) });
    expect(a.verdict).toBe('signed');
    expect(b.resultAt).toBeNull();

    // The daemon's side: its JSONL for the same machine, in its exact line shape.
    const jsonl =
      daemonJsonlLine({ grantId: 'grant_a', principal, op: 'exec', verdict: 'allow', argsHash: 'hash_a', exitCode: 0 }, NOW.getTime() + 400)
      + daemonJsonlLine({ grantId: 'grant_b', principal, op: 'fs_read', verdict: 'deny:not_allowed', argsHash: 'hash_b', exitCode: null }, NOW.getTime() + 1400)
      + daemonJsonlLine({ grantId: null, principal: null, op: null, verdict: 'dropped:malformed', argsHash: null, exitCode: null }, NOW.getTime() + 1600);
    const daemonLines = jsonl.trim().split('\n').map((line) => JSON.parse(line) as { grantId: string | null; op: string | null; argsHash: string | null; exitCode: number | null; verdict: string });

    // The join: by grantId, from the server's rows to the daemon's lines.
    const serverRows = await store.listForEnv({ envId, limit: 50 });
    const joined = serverRows
      .filter((row) => row.resultAt !== null)
      .map((row) => ({ row, line: daemonLines.filter((line) => line.grantId === row.grantId) }));
    expect(joined).toHaveLength(2);
    for (const { row, line } of joined) {
      expect(line).toHaveLength(1);
      expect(line[0]!.op).toBe(row.op);
      expect(line[0]!.argsHash).toBe(row.argsHash);
      expect(line[0]!.exitCode).toBe(row.exitCode);
    }
    // The daemon line that names no grant joins to nothing — and the server's running grant has no line yet.
    expect(daemonLines.filter((line) => line.grantId === null)).toHaveLength(1);
    const running = serverRows.filter((row) => row.resultAt === null);
    expect(running.map((row) => row.grantId)).toEqual(['grant_c']);
    expect(daemonLines.some((line) => line.grantId === 'grant_c')).toBe(false);
  });
});

describe('recordSign / recordResult', () => {
  it('given a signed grant, should write verdict `signed` with resultAt NULL (running now) and carry the click when there is one', async () => {
    const row = await store.recordSign({ envId, grantId: 'grant_click', principal, op: 'exec', argsHash: 'h', summary: 'exec: rm -rf build', approval: { challengeId: 'ch_1', scope: '30d' }, now: NOW });
    expect(row).toMatchObject({ envId, grantId: 'grant_click', userId: ownerId, sessionId: 'sess_1', conversationId: 'conv_1', op: 'exec', argsHash: 'h', verdict: 'signed', exitCode: null, challengeId: 'ch_1', approvalScope: '30d', resultAt: null });
    expect(row.ts.getTime()).toBe(NOW.getTime());
  });

  it('given a result, should update ONLY the waiting row and answer null for an unknown or already-answered grant', async () => {
    await store.recordSign({ envId, grantId: 'grant_once', principal, op: 'exec', argsHash: 'h', summary: 's', now: NOW });
    const first = await store.recordResult({ grantId: 'grant_once', verdict: 'completed', exitCode: 3, now: new Date(NOW.getTime() + 100) });
    expect(first).toMatchObject({ verdict: 'completed', exitCode: 3 });
    expect(first!.resultAt!.getTime()).toBe(NOW.getTime() + 100);
    // A second answer for the same grant changes nothing (the row is no longer waiting).
    expect(await store.recordResult({ grantId: 'grant_once', verdict: 'failed:timeout', exitCode: null, now: new Date(NOW.getTime() + 200) })).toBeNull();
    const [row] = await store.listForEnv({ envId, limit: 1 });
    expect(row).toMatchObject({ verdict: 'completed', exitCode: 3 });
    expect(await store.recordResult({ grantId: 'grant_never', verdict: 'completed', exitCode: 0, now: NOW })).toBeNull();
  });

  it('given a grant id already recorded, should refuse a second sign row (partial unique on grantId)', async () => {
    await store.recordSign({ envId, grantId: 'grant_dup', principal, op: 'exec', argsHash: 'h', summary: 's', now: NOW });
    await expect(store.recordSign({ envId, grantId: 'grant_dup', principal, op: 'exec', argsHash: 'h', summary: 's', now: NOW })).rejects.toThrow();
  });

  it('given a summary longer than the bound, should clip it to the schema ceiling (the two constants agree)', async () => {
    expect(GRANT_AUDIT_SUMMARY_MAX_CHARS).toBe(DRIVE_ENV_GRANT_AUDIT_SUMMARY_MAX_CHARS);
    const row = await store.recordSign({ envId, grantId: 'grant_long', principal, op: 'exec', argsHash: 'h', summary: 'x'.repeat(2000), now: NOW });
    expect(row.summary).toHaveLength(GRANT_AUDIT_SUMMARY_MAX_CHARS);
    expect(row.summary.endsWith('…')).toBe(true);
  });
});

describe('recordRefusal — the server would not sign', () => {
  it('given a typed reason, should write `refused:<reason>` with NO grant id and resultAt set (nothing will follow)', async () => {
    const row = await store.recordRefusal({ envId, principal, op: 'exec', argsHash: 'h', summary: 'exec: ls', reason: 'server_denied', now: NOW });
    expect(row).toMatchObject({ grantId: null, verdict: 'refused:server_denied', exitCode: null, challengeId: null });
    expect(row.resultAt!.getTime()).toBe(NOW.getTime());
  });

  it('given the CHECK, should refuse a refused row that carries a grant id and a signed row that carries none (23514)', async () => {
    const base = { envId, userId: ownerId, sessionId: 's', conversationId: 'c', op: 'exec', argsHash: 'h', summary: 's', ts: NOW };
    await expect(db.insert(driveEnvGrantAudit).values({ ...base, grantId: 'grant_x', verdict: 'refused:paused' })).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
    await expect(db.insert(driveEnvGrantAudit).values({ ...base, grantId: null, verdict: 'signed' })).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
    await expect(db.insert(driveEnvGrantAudit).values({ ...base, grantId: 'grant_y', verdict: 'signed', op: 'format_disk' })).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
  });
});

describe('the two reads', () => {
  it('listForEnv: newest first, this env only, bounded', async () => {
    for (let i = 0; i < 3; i += 1) await store.recordSign({ envId, grantId: `grant_${i}`, principal, op: 'exec', argsHash: 'h', summary: `s${i}`, now: new Date(NOW.getTime() + i * 1000) });
    await store.recordSign({ envId: otherEnvId, grantId: 'grant_other', principal: { ...principal, userId: otherOwnerId }, op: 'exec', argsHash: 'h', summary: 'theirs', now: new Date(NOW.getTime() + 9000) });
    const rows = await store.listForEnv({ envId, limit: 2 });
    expect(rows.map((row) => row.grantId)).toEqual(['grant_2', 'grant_1']);
  });

  it('listForOwner: rows for the envs the user OWNS — a request the owner made on someone else\'s machine is not theirs to see here', async () => {
    await store.recordSign({ envId, grantId: 'grant_mine', principal, op: 'exec', argsHash: 'h', summary: 'mine', now: NOW });
    // The owner (as principal) drove the OTHER user's machine: that row belongs to the other owner's page.
    await store.recordSign({ envId: otherEnvId, grantId: 'grant_on_theirs', principal, op: 'exec', argsHash: 'h', summary: 'on theirs', now: new Date(NOW.getTime() + 1000) });
    expect((await store.listForOwner({ ownerId, limit: 50 })).map((row) => row.grantId)).toEqual(['grant_mine']);
    expect((await store.listForOwner({ ownerId: otherOwnerId, limit: 50 })).map((row) => row.grantId)).toEqual(['grant_on_theirs']);
  });

  it('deleting the env cascades its audit rows away', async () => {
    await store.recordSign({ envId, grantId: 'grant_gone', principal, op: 'exec', argsHash: 'h', summary: 's', now: NOW });
    await db.delete(driveEnvs).where(eq(driveEnvs.id, envId));
    expect(await db.select().from(driveEnvGrantAudit).where(eq(driveEnvGrantAudit.envId, envId))).toEqual([]);
  });
});
