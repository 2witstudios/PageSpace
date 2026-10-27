/**
 * Seeds EVERY precondition for the global-assistant cloud-reach exit gate
 * (#2616, phase `de301c773t025ivjwf5ygtlb`).
 *
 * **The story being proved:** *from the dashboard, my global assistant can use
 * any cloud environment I could run code in myself, and nothing else.*
 *
 * Reproducible by construction. The M1 gate was run once with two fields set
 * BY HAND (`driveMembers.acceptedAt`, `pages.userScopedAccess`), which made
 * that run unreproducible from its own script and was caught as a P1 twice.
 * Nothing here is hand-applied: run this against a clean database and every
 * precondition exists.
 *
 *   DATABASE_URL=… TZ=UTC bun scripts/ga-cloud-reach-gate/seed-gate.ts
 *
 * `TZ=UTC` on this process AND on the cluster (`ALTER DATABASE <db> SET
 * timezone='UTC'`): `sessions` timestamps are UTC wall-clock while `now()`
 * resolves through the session timezone, so a non-UTC cluster mints a session
 * that is already expired and every later request 401s.
 *
 * ## What it creates, and why each piece is load-bearing
 *
 *  - **U, on the `free` tier.** `SANDBOX_ELIGIBLE_TIERS` is
 *    `['pro','founder','business']`, so U's OWN tier can never run a sandbox.
 *    This is the whole point: the founder's ruling is that U's assistant may
 *    use what U may use, and U may run code in a PAID drive because
 *    `canRunCode` resolves the tier of the drive's PAYER, not the actor's. A
 *    gate seeded with a pro-tier U would pass while proving nothing about the
 *    case that was broken in production.
 *  - **Drive P**, owned by a `pro` payer, U an ACCEPTED member with `MEMBER`
 *    role (which carries `canEdit`), holding Sprite env `p-env`.
 *    `acceptedAt` is nullable with NO default and `permissions.ts` requires
 *    `isNotNull(acceptedAt)`; a row without it is a PENDING INVITE and every
 *    door answers `drive_access_denied` — earlier, and for a different reason
 *    than the one under test.
 *  - **Drive V**, `pro`, U an accepted member bounded to VIEW-ONLY. There is no
 *    `VIEWER` value in the `MemberRole` enum (`OWNER | ADMIN | MEMBER`): a
 *    view-only collaborator is a `MEMBER` carrying a CUSTOM ROLE whose
 *    `driveWidePermissions.canEdit` is false, which is the one shape
 *    `getUserDrivePermissions` reads as `canEdit: false`, and therefore the
 *    only way `canRunCode` reaches `insufficient_role`. Seeding a plain
 *    `MEMBER` here would have made U an EDITOR of V and the row would have
 *    proved the opposite of what it claims. Row 5 later clears the custom role
 *    to prove the refusal was the permission answering, not a broken fixture.
 *  - **Drive X**, `pro`, U NOT a member at all. `x-env` must be refused with
 *    the IDENTICAL message, so a real id in a drive you cannot see is
 *    indistinguishable from a guess.
 *  - **A page agent in P** for row 7: a page conversation must be refused
 *    `not_global` even for an env its own drive owns.
 *
 * Every env is `substrate: 'sprite'` and carries NO Sprite pointer: an env
 * provisions lazily on first use, which is what row 2 exercises for real.
 *
 * Everything here is DATA. No decision this gate tests is made in this file.
 */
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { factories } from '@pagespace/db/test/factories';
import { driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { conversations } from '@pagespace/db/schema/conversations';
import { sessionService } from '../../packages/lib/src/auth/session-service';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A VIEW-ONLY custom role for a drive.
 *
 * There is no `VIEWER` in the `MemberRole` enum (`OWNER | ADMIN | MEMBER`): a
 * view-only collaborator is a `MEMBER` carrying a custom role whose
 * `driveWidePermissions.canEdit` is false, which is the one shape
 * `getUserDrivePermissions` reads as `canEdit: false` and therefore the only
 * way `canRunCode` reaches `insufficient_role`.
 */
async function seedViewOnlyRole(driveId: string, now: Date) {
  const [role] = await db
    .insert(driveRoles)
    .values({
      driveId,
      name: 'Gate view-only',
      permissions: {},
      driveWidePermissions: { canView: true, canEdit: false, canShare: false },
      updatedAt: now,
    })
    .returning();
  if (!role) throw new Error(`failed to seed the view-only role for ${driveId}`);
  return role;
}

/** A paid drive with its own payer, and a Sprite env inside it. */
async function seedPaidDriveWithEnv(label: string, envName: string, now: Date) {
  const payer = await factories.createUser({ subscriptionTier: 'pro' });
  const drive = await factories.createDrive(payer.id, { name: label });
  await db.insert(driveMembers).values({ id: createId(), driveId: drive.id, userId: payer.id, role: 'OWNER', acceptedAt: now });
  const [env] = await db
    .insert(driveEnvs)
    .values({ driveId: drive.id, name: envName, substrate: 'sprite', createdBy: payer.id, updatedAt: now })
    .returning();
  if (!env) throw new Error(`failed to seed env ${envName}`);
  return { payer, drive, env };
}

async function main() {
  const now = new Date();

  // U: the person whose OWN tier cannot run a sandbox. The case the ruling is for.
  const u = await factories.createUser({ subscriptionTier: 'free' });

  const p = await seedPaidDriveWithEnv('Gate drive P (U can edit)', 'p-env', now);
  const v = await seedPaidDriveWithEnv('Gate drive V (U is viewer)', 'v-env', now);
  const x = await seedPaidDriveWithEnv('Gate drive X (U not a member)', 'x-env', now);

  // ACCEPTED membership, both times — a pending invite is not a member, and
  // every door answers `drive_access_denied` earlier and for another reason.
  await db.insert(driveMembers).values({ id: createId(), driveId: p.drive.id, userId: u.id, role: 'MEMBER', acceptedAt: now });

  // V: a MEMBER bounded to view-only by a custom role. See the docblock — this
  // is the only shape that yields `canEdit: false`, and therefore the only way
  // `canRunCode` can answer `insufficient_role`.
  const viewOnlyRole = await seedViewOnlyRole(v.drive.id, now);
  await db.insert(driveMembers).values({
    id: createId(),
    driveId: v.drive.id,
    userId: u.id,
    role: 'MEMBER',
    customRoleId: viewOnlyRole.id,
    acceptedAt: now,
  });

  // Drive X: deliberately NO row for U.

  // R6 demotes U inside P mid-conversation, through the members API. The role
  // it demotes TO has to exist first — the gate may not reach past the
  // application to invent one, so it is seeded here as data.
  const pViewOnlyRole = await seedViewOnlyRole(p.drive.id, now);

  // Row 7: a page agent inside P. `userScopedAccess` so the agent can be used
  // by U at all — a factory-made agent holds no page permissions of its own.
  const agent = await factories.createPage(p.drive.id, {
    title: 'Gate page agent',
    type: 'AI_CHAT',
    userScopedAccess: true,
  });

  // R7 drives a PAGE conversation. `type: 'page'` with the agent page in
  // `contextId` is the authority every page-scoped reader derives from — a
  // `client` row cannot stand in for it.
  const [pageConversation] = await db
    .insert(conversations)
    .values({ userId: u.id, type: 'page', contextId: agent.id, title: 'Gate page conversation', updatedAt: now })
    .returning();
  if (!pageConversation) throw new Error('failed to seed the page conversation');

  const session = await sessionService.createSession({ userId: u.id, type: 'user', scopes: [], expiresInMs: SESSION_TTL_MS });
  const payerSessionP = await sessionService.createSession({ userId: p.payer.id, type: 'user', scopes: [], expiresInMs: SESSION_TTL_MS });
  const payerSessionV = await sessionService.createSession({ userId: v.payer.id, type: 'user', scopes: [], expiresInMs: SESSION_TTL_MS });

  console.log(
    JSON.stringify(
      {
        u: { userId: u.id, email: u.email, tier: 'free', session },
        p: { driveId: p.drive.id, envId: p.env.id, envName: 'p-env', payerId: p.payer.id, payerSession: payerSessionP, uRole: 'MEMBER' },
        v: { driveId: v.drive.id, envId: v.env.id, envName: 'v-env', payerId: v.payer.id, payerSession: payerSessionV, uRole: 'MEMBER(view-only custom role)', viewOnlyRoleId: viewOnlyRole.id },
        x: { driveId: x.drive.id, envId: x.env.id, envName: 'x-env', payerId: x.payer.id, uRole: null },
        agentPageId: agent.id,
        pageConversationId: pageConversation.id,
        pViewOnlyRoleId: pViewOnlyRole.id,
      },
      null,
      2,
    ),
  );
  process.exit(0); // the pg pool holds the process open otherwise
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
