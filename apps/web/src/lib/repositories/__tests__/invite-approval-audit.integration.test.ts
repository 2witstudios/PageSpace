/**
 * AUD-1 for an approved guest whose admission is an EMAILED invitation (drive invite to an address, page invite):
 * the approval event is staged with the pending-invite row, held deliver-unless-undone. A process that dies after the
 * invite committed (and possibly after its email went out) but before publishing loses nothing: the drainer delivers
 * the event when the hold ends. An undone invite (failed email) discards it first. Real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { orgAuditOutbox } from '@pagespace/db/schema/organizations';
import { pendingInvites } from '@pagespace/db/schema/pending-invites';
import { pendingPageInvites } from '@pagespace/db/schema/pending-page-invites';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import type { AuditEvent, SecurityAuditService } from '@pagespace/lib/audit/security-audit';
import type { drainOrgAuditOutbox as DrainOrgAuditOutbox, discardStagedOrgAuditEvents as DiscardStaged, OrgAuditEvent } from '@pagespace/lib/audit/org-audit';
import { driveInviteRepository } from '../drive-invite-repository';
import { pageInviteRepository } from '../page-invite-repository';

// The repositories reach lib's BUILT (CommonJS) audit modules: capture the chain append on that instance.
const requireLib = createRequire(import.meta.url);
const { securityAudit } = requireLib('@pagespace/lib/audit/security-audit') as { securityAudit: SecurityAuditService };
const audit = requireLib('@pagespace/lib/audit/org-audit') as { drainOrgAuditOutbox: typeof DrainOrgAuditOutbox; discardStagedOrgAuditEvents: typeof DiscardStaged };
/** Well inside the hold (minutes) and well past it (a day): the hold is ORG_AUDIT_PENDING_HOLD_MS, 15 minutes. */
const withinHold = () => new Date(Date.now() + 60_000);

const appended: AuditEvent[] = [];
const orgId = `org_${createId()}`;
const created = { users: [] as string[], drives: [] as string[] };
let dbAvailable = false;
let w: { owner: string; drive: string; page: string };

const approval = (details: Record<string, unknown>): OrgAuditEvent => ({
  orgId, eventType: 'org.guest.approved', actorId: w.owner, resourceType: 'drive', resourceId: w.drive, driveId: w.drive, details,
});
const approvals = () => appended.filter((e) => e.eventType === 'org.guest.approved' && e.details?.orgId === orgId).map((e) => e.details);
const afterHold = () => new Date(Date.now() + 24 * 60 * 60_000);

beforeAll(async () => {
  try {
    await db.select({ id: orgAuditOutbox.id }).from(orgAuditOutbox).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('invite-approval-audit.integration.test.ts', error);
  }
  if (!dbAvailable) return;
  vi.spyOn(securityAudit, 'logEvent').mockImplementation(async (entry) => {
    appended.push(entry);
  });
  const owner = await factories.createUser();
  created.users.push(owner.id);
  const drive = await factories.createDrive(owner.id);
  created.drives.push(drive.id);
  const page = await factories.createPage(drive.id, { isPrivate: false });
  w = { owner: owner.id, drive: drive.id, page: page.id };
});

afterEach(() => {
  appended.length = 0;
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (!dbAvailable) return;
  await db.delete(orgAuditOutbox).where(eq(orgAuditOutbox.orgId, orgId));
  await db.delete(pendingInvites).where(inArray(pendingInvites.driveId, created.drives));
  await db.delete(drives).where(inArray(drives.id, created.drives));
  await db.delete(users).where(inArray(users.id, created.users));
});

describe('an emailed invitation carries its approval event (AUD-1)', () => {
  it('AUD-1 (partial) a drive invitation committed but never published (crash after the email) is delivered by the drainer when the hold ends', async () => {
    if (!dbAvailable) return;
    const invite = await driveInviteRepository.createPendingInvite({
      tokenHash: createId(), email: `x-${createId()}@guest.test`, driveId: w.drive, role: 'MEMBER', customRoleId: null,
      invitedBy: w.owner, expiresAt: null, now: new Date(), approval: approval({ via: 'drive_invite' }),
    });
    expect(invite.approvalStaged).toHaveLength(1);
    // No publish: the process stopped. Within the hold the drainer leaves it alone (the email may still fail and undo it).
    await audit.drainOrgAuditOutbox({ now: withinHold() });
    expect(approvals()).toEqual([]);
    await audit.drainOrgAuditOutbox({ now: afterHold() });
    expect(approvals()).toEqual([expect.objectContaining({ via: 'drive_invite' })]);
  });

  it('AUD-1 (partial) a page invitation committed but never published is delivered the same way', async () => {
    if (!dbAvailable) return;
    const invite = await pageInviteRepository.createPendingInvite({
      tokenHash: createId(), email: `y-${createId()}@guest.test`, pageId: w.page, permissions: ['VIEW'],
      invitedBy: w.owner, expiresAt: null, now: new Date(), approval: approval({ via: 'page_invite' }),
    });
    await audit.drainOrgAuditOutbox({ now: afterHold() });
    expect(approvals()).toEqual([expect.objectContaining({ via: 'page_invite' })]);
    await db.delete(pendingPageInvites).where(eq(pendingPageInvites.id, invite.id));
  });

  it('AUD-1 (partial) an undone invitation (its email failed) takes its approval event with it: nothing is delivered', async () => {
    if (!dbAvailable) return;
    const invite = await driveInviteRepository.createPendingInvite({
      tokenHash: createId(), email: `z-${createId()}@guest.test`, driveId: w.drive, role: 'MEMBER', customRoleId: null,
      invitedBy: w.owner, expiresAt: null, now: new Date(), approval: approval({ via: 'undone' }),
    });
    await audit.discardStagedOrgAuditEvents(db, invite.approvalStaged);
    await driveInviteRepository.deletePendingInvite(invite.id);
    await audit.drainOrgAuditOutbox({ now: afterHold() });
    expect(approvals()).toEqual([]);
  });
});
