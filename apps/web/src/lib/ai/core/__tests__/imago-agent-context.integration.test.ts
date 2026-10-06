// @vitest-environment node
/**
 * `imago-agent-context` against a REAL Postgres (IMG-4.7; reshaped by
 * IMG-10.10): which page counts as the user's own Imago, and which drives the
 * user keeps it out of. Every case is a trust-boundary case — another user's
 * Imago, a trashed one and an ordinary agent must never be treated as the
 * caller's own, and the exclusions must be the caller's own choices only.
 *
 * Requires DATABASE_URL → a migrated Postgres. Fails loudly without one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { factories } from '@pagespace/db/test/factories';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { setImagoDriveAccess } from '@pagespace/lib/agents/imago-drive-access';
import { ensureTestDb } from '@/test/ensure-test-db';
import {
  findBuiltinAgentOwner,
  findOwnImagoHomeDriveId,
  loadImagoAgentContext,
  resolveImagoDriveInView,
  resolveImagoLocationAccess,
} from '../imago-agent-context';

const seededUserIds: string[] = [];

async function imagoUser() {
  const user = await factories.createUser();
  seededUserIds.push(user.id);
  const home = await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: 'home' });
  const { agents } = await provisionImagoAgents(user.id);
  return { user, home, imagoPageId: agents.imago };
}

beforeAll(async () => {
  await ensureTestDb();
});

afterAll(async () => {
  if (seededUserIds.length === 0) return;
  await db.delete(drives).where(inArray(drives.ownerId, seededUserIds));
  await db.delete(users).where(inArray(users.id, seededUserIds));
});

describe('loadImagoAgentContext (integration)', () => {
  it("given the user's own Imago, should return its Home drive and the drives the user keeps it out of", async () => {
    const { user, home, imagoPageId } = await imagoUser();
    const kept = await factories.createDrive(user.id, { name: 'Kept', slug: `k-${createId()}` });
    const out = await factories.createDrive(user.id, { name: 'Out', slug: `o-${createId()}` });
    expect((await setImagoDriveAccess(user.id, out.id, false)).ok).toBe(true);

    const context = await loadImagoAgentContext({ userId: user.id, agentPageId: imagoPageId });

    expect(context).toEqual({ homeDriveId: home.id, excludedDriveIds: new Set([out.id]) });
    expect(context?.excludedDriveIds.has(kept.id)).toBe(false);
  });

  it("given another user's Imago, should return null — never their exclusions, never treated as the caller's", async () => {
    const owner = await imagoUser();
    const caller = await imagoUser();

    expect(await loadImagoAgentContext({ userId: caller.user.id, agentPageId: owner.imagoPageId })).toBeNull();
    expect(await findOwnImagoHomeDriveId(caller.user.id, owner.imagoPageId)).toBeNull();
    expect(await findBuiltinAgentOwner(owner.imagoPageId)).toBe(owner.user.id);
  });

  it('given a trashed Imago page, should return null', async () => {
    const { user, imagoPageId } = await imagoUser();
    await db.update(pages).set({ isTrashed: true, trashedAt: new Date() }).where(eq(pages.id, imagoPageId));

    expect(await loadImagoAgentContext({ userId: user.id, agentPageId: imagoPageId })).toBeNull();
    expect(await findOwnImagoHomeDriveId(user.id, imagoPageId)).toBeNull();
  });

  it('given an ordinary agent page, should return null and report no built-in owner', async () => {
    const { user, home } = await imagoUser();
    const agent = await factories.createPage(home.id, { title: 'Plain', type: 'AI_CHAT' });

    expect(await loadImagoAgentContext({ userId: user.id, agentPageId: agent.id })).toBeNull();
    expect(await findBuiltinAgentOwner(agent.id)).toBeNull();
  });
});

describe('resolveImagoLocationAccess / resolveImagoDriveInView', () => {
  const context = { homeDriveId: 'home_1', excludedDriveIds: new Set(['drive_out']) };
  const at = (id: string) => ({ currentDrive: { id, name: 'Drive', slug: 'drive' } });

  it('given a drive the user keeps Imago out of, should flag it and offer no drive to use', () => {
    expect(resolveImagoLocationAccess(at('drive_out'), context)).toEqual({ kind: 'excluded' });
    expect(resolveImagoDriveInView(at('drive_out'), context)).toBeNull();
  });

  it('given any other drive, Home included, should leave the location as is and offer that drive', () => {
    for (const id of ['home_1', 'drive_in']) {
      expect(resolveImagoLocationAccess(at(id), context)).toBeUndefined();
      expect(resolveImagoDriveInView(at(id), context)).toBe(id);
    }
  });

  it('given no drive in view, should offer none', () => {
    expect(resolveImagoLocationAccess(null, context)).toBeUndefined();
    expect(resolveImagoDriveInView(null, context)).toBeNull();
  });
});
