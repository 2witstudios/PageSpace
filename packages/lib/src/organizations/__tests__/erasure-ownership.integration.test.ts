import { drizzle } from 'drizzle-orm/node-postgres';
import { lockOwnershipSubject } from '../owner-candidate';
import { afterAll, describe, expect, it } from 'vitest';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { dataSubjectRequests } from '@pagespace/db/schema/data-subject-requests';
import { createId } from '@paralleldrive/cuid2';
import { createOrganization } from '../repository';
import { transferOwnership } from '../membership';
import { dataSubjectRequestRepository } from '../../repositories/data-subject-request-repository';

const userIds: string[] = [];
const orgIds: string[] = [];
async function world() {
  const owner = await factories.createUser();
  const subject = await factories.createUser();
  userIds.push(owner.id, subject.id);
  const created = await createOrganization({ name: 'Erasure race', slug: `erasure-${createId()}`, ownerId: owner.id });
  if (!created.ok) throw new Error('fixture organization refused');
  orgIds.push(created.organization.id);
  await db.insert(orgMembers).values({ orgId: created.organization.id, userId: subject.id, role: 'ADMIN' });
  await factories.createOrgSubscription(created.organization.id);
  return { owner, subject, orgId: created.organization.id };
}
afterAll(async () => {
  await db.delete(dataSubjectRequests).where(inArray(dataSubjectRequests.userId, userIds));
  await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
  await db.delete(organizations).where(inArray(organizations.id, orgIds));
  await db.delete(users).where(inArray(users.id, userIds));
});
describe('erasure admission and ownership assignment serialize on the subject', () => {
  for (const operation of ['transfer', 'create'] as const) {
    it(`ORG-6 (partial) ${operation} waiting behind erasure admission cannot assign ownership after its pending row commits`, async () => {
      const w = await world();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [w.subject.id]);
        await client.query(`INSERT INTO data_subject_requests (id,user_id,subject_email,request_type,status,sla_deadline) VALUES ($1,$2,$3,'erasure','pending',now()+interval '30 days')`, [createId(),w.subject.id,w.subject.email]);
        const [{ pid }] = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
        const assign = operation === 'transfer'
          ? transferOwnership({ orgId: w.orgId, actorId: w.owner.id, targetId: w.subject.id })
          : createOrganization({ name: 'Forbidden', slug: `forbidden-${createId()}`, ownerId: w.subject.id });
        let blocked = false;
        for (let attempt=0;attempt<100;attempt++) {
          const result = await pool.query<{ blocked: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid]);
          if (result.rows[0].blocked) { blocked=true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked, 'assignment must reach the subject-lock barrier').toBe(true);
        await client.query('COMMIT');
        const result = await assign;
        if (operation==='create' && result.ok && 'organization' in result) orgIds.push(result.organization.id);
        expect(result).toMatchObject({ ok: false, reason: 'owner_erasure_in_progress' });
        expect(await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.ownerId,w.subject.id))).toEqual([]);
      } finally { await client.query('ROLLBACK'); client.release(); }
    });
  }
  it('ORG-6 (partial) lodging erasure after ownership has committed refuses before storing an erasure request', async () => {
    const w=await world();
    expect(await transferOwnership({orgId:w.orgId,actorId:w.owner.id,targetId:w.subject.id})).toEqual({ok:true});
    await expect(dataSubjectRequestRepository.create({userId:w.subject.id,subjectEmail:w.subject.email!,receivedAt:new Date()})).rejects.toThrow();
    expect(await db.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.userId,w.subject.id))).toEqual([]);
  });
  for (const [status, started, refused] of [['in_progress',true,true],['blocked',true,true],['failed',true,true],['failed',false,false],['cancelled',true,false]] as const) {
    it(`ORG-6 (partial) ${status} started=${started} preserves ownership eligibility=${!refused}`, async () => {
      const w=await world();
      await db.insert(dataSubjectRequests).values({userId:w.subject.id,subjectEmail:w.subject.email!,status,startedAt:started?new Date():null,slaDeadline:new Date(Date.now()+86400000)});
      const result=await transferOwnership({orgId:w.orgId,actorId:w.owner.id,targetId:w.subject.id});
      expect(result).toEqual(refused?{ok:false,status:400,reason:'owner_erasure_in_progress'}:{ok:true});
      expect(Boolean(await dataSubjectRequestRepository.findActiveErasureForUser(w.subject.id))).toBe(refused);
    });
  }

  it('ORG-6 (partial) a resumed failed request claims retirement before purging; cancellation cannot be reclaimed and releases normal transfer', async () => {
    const w = await world();
    const request = await dataSubjectRequestRepository.create({ userId: w.subject.id, subjectEmail: w.subject.email!, receivedAt: new Date() });
    await dataSubjectRequestRepository.markFailed(request.id, 'enqueue failed');
    expect(await dataSubjectRequestRepository.claimErasure(request.id, w.subject.id)).toBe(true);
    expect(await transferOwnership({ orgId: w.orgId, actorId: w.owner.id, targetId: w.subject.id })).toMatchObject({ ok: false, reason: 'owner_erasure_in_progress' });
    // A stopped, blocked worker may be cancelled; an in-progress purge cannot be cancelled.
    await dataSubjectRequestRepository.updateStatus(request.id, 'blocked', { blockedReason: 'manual resolution' });
    await dataSubjectRequestRepository.updateStatus(request.id, 'cancelled');
    expect(await dataSubjectRequestRepository.claimErasure(request.id, w.subject.id)).toBe(false);
    expect(await transferOwnership({ orgId: w.orgId, actorId: w.owner.id, targetId: w.subject.id })).toEqual({ ok: true });
  });

  it('ORG-6 (partial) erasure admission waiting behind an owner assignment refuses after its ownership commits', async () => {
    const w = await world();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [w.subject.id]);
      await client.query('UPDATE organizations SET "ownerId"=$1 WHERE id=$2', [w.subject.id, w.orgId]);
      const [{ pid }] = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      const lodge = dataSubjectRequestRepository.create({ userId: w.subject.id, subjectEmail: w.subject.email!, receivedAt: new Date() });
      const refusal = expect(lodge).rejects.toThrow('OWNER_MUST_TRANSFER');
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await pool.query<{ blocked: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid]);
        if (result.rows[0].blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await client.query('COMMIT');
      await refusal;
      expect(await db.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.userId, w.subject.id))).toEqual([]);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('ORG-6 (partial) crossed admin erasure requests serialize each subject without deadlocking requester foreign keys', async () => {
    const a = await factories.createUser();
    const b = await factories.createUser();
    userIds.push(a.id, b.id);
    const left = await pool.connect();
    const right = await pool.connect();
    try {
      await left.query('BEGIN');
      await right.query('BEGIN');
      await lockOwnershipSubject(drizzle(left), a.id);
      await lockOwnershipSubject(drizzle(right), b.id);
      const insert = (client: typeof left, subject: typeof a, requester: typeof b) => client.query(
        `INSERT INTO data_subject_requests (id,user_id,subject_email,requested_by_user_id,requested_by_type,request_type,status,sla_deadline) VALUES ($1,$2,$3,$4,'admin','erasure','pending',now()+interval '30 days')`,
        [createId(), subject.id, subject.email, requester.id],
      );
      // Both logical subject locks are held before either crossed FK is checked.
      const results = await Promise.allSettled([insert(left, a, b), insert(right, b, a)]);
      expect(results.map((result) => result.status === 'fulfilled' ? { status: result.status } : { status: result.status, code: (result.reason as { code?: string }).code })).toEqual([{ status: 'fulfilled' }, { status: 'fulfilled' }]);
    } finally {
      await left.query('ROLLBACK'); await right.query('ROLLBACK');
      left.release(); right.release();
    }
  });

});
