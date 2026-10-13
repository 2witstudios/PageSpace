// @vitest-environment node
/**
 * D-OW-62 against PostgreSQL: a memory page restating content distilled from an org's drives is withheld from a
 * credential that org's sign-in policy refuses on the paths that ENUMERATE a drive's pages rather than ask about one
 * page — an agent's membership listing (behind regex_search, glob_search, multi-drive search and list_pages) and a
 * page's children listing. The person's ordinary pages in the same drive stay readable; a passkey credential reads all.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { provisionMemoryPages } from '@pagespace/lib/memory/memory-pages';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';
import type { ToolExecutionContext } from '@/lib/ai/core/types';

// The tool registry and the workflow executor import each other; load the registry first, as the app's agent routes do.
import '@/lib/ai/core/ai-tools';
import { searchTools } from '@/lib/ai/tools/search-tools';
import { recordMemoryOrgIds } from '@/lib/memory/candidate-service';
import { GET as getChildren } from '@/app/api/pages/[pageId]/children/route';

const created = { users: [] as string[], orgs: [] as string[] };

const evidence = (assurance: VerifiedAuthentication['assurance']): VerifiedAuthentication => ({ authenticatedAtMs: Date.now(), assurance });

/** A person whose memory was distilled from a passkey-only org, with a Home-drive agent and an ordinary page. */
async function personWithOrgMemory() {
  const person = await factories.createUser();
  created.users.push(person.id);
  const [org] = await db.insert(organizations).values({
    name: 'Acme', slug: `acme-${createId()}`, ownerId: person.id, policies: { requireStrongSignIn: true },
  }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: person.id, role: 'OWNER' });

  const home = await factories.createDrive(person.id);
  const memory = await db.transaction((tx) => provisionMemoryPages(person.id, home.id, tx));
  await db.update(pages).set({ content: 'Always cite the ACME-SECRET launch plan.' }).where(eq(pages.id, memory.rulesPageId));
  await recordMemoryOrgIds(person.id, [org.id]);
  const notes = await factories.createPage(home.id, { title: 'Notes', content: 'My own ACME-SECRET-free shopping list.' });

  // As page-agent creation does: the agent is a MEMBER of its home drive, so its listing is a membership listing.
  const agent = await factories.createPage(home.id, { title: 'Helper', type: 'AI_CHAT', content: '', enabledTools: ['regex_search'] });
  await db.insert(driveAgentMembers).values({ driveId: home.id, agentPageId: agent.id, role: 'MEMBER', addedBy: person.id });
  return { person, home, memory, notes, agent };
}

const agentContext = (userId: string, agentPageId: string, authentication: VerifiedAuthentication): ToolExecutionContext => ({
  userId, accessActor: credentialActor(userId, authentication), chatSource: { type: 'page', agentPageId },
});

async function regexSearch(context: ToolExecutionContext, driveId: string): Promise<string> {
  const result = await searchTools.regex_search.execute!(
    { driveId, pattern: 'ACME-SECRET', searchIn: 'content', maxResults: 50, contentTypes: ['documents'] },
    { toolCallId: createId(), messages: [], experimental_context: context },
  );
  return JSON.stringify(result);
}

const session = (userId: string, assurance: VerifiedAuthentication['assurance']) =>
  sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 3_600_000, authentication: evidence(assurance) });

async function childIds(pageId: string, token: string): Promise<string[]> {
  const res = await getChildren(new Request(`https://app.test/api/pages/${pageId}/children`, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ pageId }) });
  expect(res.status).toBe(200);
  return (await res.json() as Array<{ id: string }>).map((child) => child.id);
}

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration suite');
});

afterEach(async () => {
  if (created.orgs.length) await db.delete(drives).where(inArray(drives.orgId, created.orgs));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)));
});

describe('memory pages on the listings that enumerate a drive (D-OW-62)', () => {
  it('SEC-2 (partial) regex_search through a Home-drive agent driven by a single-factor credential finds the ordinary page but not the memory page an org withholds; a passkey credential finds both', async () => {
    const { person, home, memory, notes, agent } = await personWithOrgMemory();

    const weak = await regexSearch(agentContext(person.id, agent.id, evidence('single_factor')), home.id);
    expect(weak).toContain(notes.id);
    expect(weak).not.toContain(memory.rulesPageId);
    expect(weak).not.toContain('launch plan');

    const strong = await regexSearch(agentContext(person.id, agent.id, evidence('user_verified_passkey')), home.id);
    expect(strong).toContain(notes.id);
    expect(strong).toContain(memory.rulesPageId);
  });

  it('SEC-2 (partial) a page\'s children listing leaves out the memory pages a single-factor session is refused, though it may open their folder; a passkey session lists them', async () => {
    const { person, memory } = await personWithOrgMemory();
    const memoryPages = [memory.bioPageId, memory.writingStylePageId, memory.rulesPageId];

    expect(await childIds(memory.folderId, await session(person.id, 'single_factor'))).toEqual([]);
    expect(await childIds(memory.folderId, await session(person.id, 'user_verified_passkey'))).toEqual(expect.arrayContaining(memoryPages));
  });
});
