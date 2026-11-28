/**
 * ARCH-2 — the drive-transition access delta, against a real Postgres.
 *
 * A drive transition can end access WITHOUT deleting a row (org Owner/Admin power over a
 * moved-out Private drive is rowless; an OPEN drive's implicit membership has no row), and a
 * move changes WHICH org's sign-in policy governs every held room. This file proves the
 * post-commit invalidation closes both live paths:
 *
 *   - every BEFORE-audience member whose effective access the committed state no longer
 *     grants is kicked from the drive's realtime rooms (the row sync alone never sees them);
 *   - everyone still admitted gets a drive-list event, and the drive's owner — who needs no
 *     row on a personal drive — is never revoked;
 *   - a change of governing org announces `org:changed {change: 'policy'}` to the union
 *     audience, which is the realtime fanout's recheck trigger, so a kept-row holder whose
 *     credential fails the NEW policy is evicted by the watch, not by a kick;
 *   - a trashed drive revokes everyone but its owner.
 *
 * Locally:
 *   DATABASE_URL=... bunx vitest run src/services/__tests__/drive-transition-invalidation.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createId } from '@paralleldrive/cuid2';

// Broadcast signing env, independent of which config loads the shared setup file.
process.env.REALTIME_BROADCAST_SECRET = process.env.REALTIME_BROADCAST_SECRET || 'test-realtime-broadcast-secret-32-chars-minimum-length';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { publishDriveTransitionInvalidation } from '../drive-transition-invalidation';
import { createSignedBroadcastHeaders } from '../../auth/broadcast-auth';
import type { OrgMembershipSyncPorts } from '../org-membership-sync';

let dbAvailable = false;

const created = {
  users: [] as string[],
  drives: [] as string[],
  orgs: [] as string[],
};

// The recorded ports: kicks and drive-list events, in order.
let kicks: Array<{ userId: string; driveId: string }>;
let broadcasts: Array<{ userId: string; operation: string }>;
const ports: OrgMembershipSyncPorts = {
  broadcast: async (user) => { broadcasts.push({ userId: user.userId, operation: user.operation }); },
  kick: async (target) => { kicks.push(target); },
};

// The realtime stub: records every broadcast body the policy announcement posts.
let fanoutBodies: string[] = [];
let realtimeServer: Server | null = null;
let realtimeUrl: string | null = null;

beforeAll(async () => {
  try {
    await db.select().from(users).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('drive-transition-invalidation.integration.test.ts', error);
    dbAvailable = false;
  }
  if (!dbAvailable) return;
  fanoutBodies = [];
  realtimeServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      fanoutBodies.push(body);
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => realtimeServer!.listen(0, '127.0.0.1', resolve));
  const address = realtimeServer.address();
  realtimeUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  process.env.INTERNAL_REALTIME_URL = realtimeUrl;
  // Reachability probe: fail loudly here (with cause) rather than inside a publish.
  try {
    const probe = await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders('{}'),
      body: '{}',
      signal: AbortSignal.timeout(2000),
    });
    if (!probe.ok) throw new Error(`probe status ${probe.status}`);
  } catch (probeError) {
    throw new Error(`realtime stub unreachable: ${probeError instanceof Error ? probeError.message : String(probeError)}`);
  }
});

afterAll(async () => {
  process.env.INTERNAL_REALTIME_URL = realtimeUrl === null ? undefined : process.env.INTERNAL_REALTIME_URL === realtimeUrl ? undefined : process.env.INTERNAL_REALTIME_URL;
  if (realtimeServer) await new Promise<void>((resolve) => realtimeServer!.close(() => resolve()));
  if (!dbAvailable) return;
  if (created.drives.length) await db.delete(drives).where(inArray(drives.id, created.drives));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users));
  await pool.end();
});

function resetRecordings() {
  kicks = [];
  broadcasts = [];
  fanoutBodies = [];
}

async function person(): Promise<string> {
  const u = await factories.createUser({ subscriptionTier: 'pro' });
  created.users.push(u.id);
  return u.id;
}

/** An org drive owned by `ownerId`, with `adminId` an org ADMIN who holds NO drive row. */
async function orgWorld(input: { ownerRole?: 'OWNER' | 'ADMIN'; visibility?: 'OPEN' | 'RESTRICTED' | 'PRIVATE' } = {}): Promise<{ orgId: string; driveId: string; ownerId: string; adminId: string }> {
  const ownerId = await person();
  const adminId = await person();
  const [org] = await db.insert(organizations).values({
    name: `Northwind ${createId()}`, slug: `arch2-${createId()}`, ownerId,
  }).returning({ id: organizations.id });
  created.orgs.push(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: ownerId, role: input.ownerRole ?? 'OWNER', joinedAt: new Date() },
    { orgId: org.id, userId: adminId, role: 'ADMIN', joinedAt: new Date() },
  ]);
  const drive = await factories.createDrive(ownerId, { orgId: org.id, orgVisibility: input.visibility ?? 'PRIVATE' });
  created.drives.push(drive.id);
  return { orgId: org.id, driveId: drive.id, ownerId, adminId };
}

describe('publishDriveTransitionInvalidation against Postgres (ARCH-2)', () => {
  it('kicks a rowless org Admin when a Private drive moves out — the row sync never saw them', async () => {
    if (!dbAvailable) return;
    const world = await orgWorld({ visibility: 'PRIVATE' });
    // The committed state AFTER a move out: the drive is personal again, the admin's rowless
    // power is gone — only the owner (no row needed) still reaches it.
    await db.update(drives).set({ orgId: null, orgVisibility: 'PRIVATE' }).where(eq(drives.id, world.driveId));
    resetRecordings();

    await publishDriveTransitionInvalidation({
      driveId: world.driveId,
      orgIdBefore: world.orgId,
      orgIdAfter: null,
      audienceBefore: [world.ownerId, world.adminId],
      ports,
    });

    expect(kicks).toEqual([{ userId: world.adminId, driveId: world.driveId }]);
    // The owner keeps access: a personal drive opens for its owner with no row at all.
    expect(broadcasts).toEqual([{ userId: world.ownerId, operation: 'member_role_changed' }]);
  });

  it('keeps an admitted row-holder and tells them to refetch; no kick', async () => {
    if (!dbAvailable) return;
    const world = await orgWorld({ visibility: 'RESTRICTED' });
    const memberId = await person();
    await db.insert(orgMembers).values({ orgId: world.orgId, userId: memberId, role: 'MEMBER', joinedAt: new Date() });
    await factories.createDriveMembers(world.driveId, [memberId], { acceptedAt: new Date() });
    resetRecordings();

    await publishDriveTransitionInvalidation({
      driveId: world.driveId,
      orgIdBefore: world.orgId,
      orgIdAfter: world.orgId,
      audienceBefore: [world.ownerId, world.adminId, memberId],
      ports,
    });

    // Same-org transition: the row-holder, the rowless org Admin (power opens RESTRICTED
    // too) and the owner are all still admitted — told to refetch, never kicked.
    expect(kicks).toEqual([]);
    expect(broadcasts.map((b) => b.userId).sort()).toEqual([world.ownerId, world.adminId, memberId].sort());
  });

  it('a change of governing org announces the policy recheck to the union audience — the realtime fanout trigger', async () => {
    if (!dbAvailable) return;
    const world = await orgWorld({ visibility: 'OPEN' });
    const outsider = await person(); // held a room before; not in the AFTER audience
    resetRecordings();

    await publishDriveTransitionInvalidation({
      driveId: world.driveId,
      orgIdBefore: world.orgId,
      orgIdAfter: null,
      audienceBefore: [world.ownerId, outsider],
      ports,
    });

    const orgChanged = fanoutBodies
      .map((body) => JSON.parse(body) as { event?: string; channelId?: string; payload?: { change?: string; orgId?: string } })
      .filter((message) => message.event === 'org:changed');
    expect(orgChanged.length).toBeGreaterThan(0);
    for (const message of orgChanged) {
      expect(message.payload).toMatchObject({ change: 'policy', orgId: world.orgId });
      expect(message.channelId).toMatch(/^notifications:/);
    }
    const recipients = orgChanged.map((message) => message.channelId).sort();
    expect(recipients).toEqual(
      [world.ownerId, world.adminId, outsider].map((id) => `notifications:${id}`).sort(),
    );
    // The old org's policy governed the rooms being vacated — the fanout re-decides them all.
  });

  it('a trashed drive revokes everyone but its owner', async () => {
    if (!dbAvailable) return;
    const world = await orgWorld({ visibility: 'OPEN' });
    await db.update(drives).set({ isTrashed: true }).where(eq(drives.id, world.driveId));
    resetRecordings();

    await publishDriveTransitionInvalidation({
      driveId: world.driveId,
      orgIdBefore: world.orgId,
      orgIdAfter: world.orgId,
      audienceBefore: [world.ownerId, world.adminId],
      ports,
    });

    expect(kicks).toEqual([{ userId: world.adminId, driveId: world.driveId }]);
    expect(broadcasts.map((b) => b.userId)).toEqual([world.ownerId]);
  });

  it('no governing-org change, no policy fanout — a same-org transition kicks only', async () => {
    if (!dbAvailable) return;
    const world = await orgWorld({ visibility: 'PRIVATE' });
    resetRecordings();

    await publishDriveTransitionInvalidation({
      driveId: world.driveId,
      orgIdBefore: world.orgId,
      orgIdAfter: world.orgId,
      audienceBefore: [],
      ports,
    });

    // Nobody lost access (the admin's rowless power still opens the Private drive).
    expect(kicks).toEqual([]);
    expect(fanoutBodies.filter((body) => body.includes('org:changed'))).toEqual([]);
  });
});
