// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';

vi.mock('@pagespace/lib/permissions/permissions', () => ({ getUserDriveAccess: vi.fn(async () => true), canUserViewPage: vi.fn(async () => true), getUserAccessiblePagesInDriveWithDetails: vi.fn(async () => []) }));
vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn() } }));
import { db } from '@pagespace/db/db';
import { drives } from '@pagespace/db/schema/core';
import { getUserDriveAccess, canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { getDriveListSummary, getPageTreeContext } from '../page-tree-context';
import { buildAgentAwarenessPrompt } from '../agent-awareness';

const actor = credentialActor('owner', { authenticatedAtMs: Date.now(), assurance: 'user_verified_passkey' });
const candidates = [{ id: 'allowed', name: 'Allowed workspace' }, { id: 'outside', name: 'Outside workspace' }];

beforeEach(() => {
  vi.clearAllMocks();
  let agentReads = 0;
  vi.mocked(db.select).mockImplementation((() => ({ from: (table: unknown) => ({ where: () => {
    const rows = table === drives ? candidates : [{ id: 'agent', title: agentReads++ === 0 ? 'Allowed agent' : 'Outside agent', definition: 'Description', visibleToGlobalAssistant: true }];
    return { then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve), orderBy: async () => rows };
  } }) })) as unknown as typeof db.select);
});

describe('assistant derived reads obey credential scope', () => {
  it.each([{ allowedDriveIds: ['allowed'] }, { allowedDriveIds: [] }])('Given drive scope %j, should enumerate only permitted drive names while preserving unscoped behavior', async ({ allowedDriveIds }) => {
    const summary = await getDriveListSummary(actor, { allowedDriveIds });
    expect(summary).toContain('Allowed workspace');
    expect(summary.includes('Outside workspace')).toBe(allowedDriveIds.length === 0);
    expect(vi.mocked(getUserDriveAccess).mock.calls.map(([, id]) => id)).toEqual(allowedDriveIds.length ? ['allowed'] : ['allowed', 'outside']);
  });

  it('Given a scoped credential, should enumerate agents only in permitted drives and retain credential-aware page checks', async () => {
    const prompt = await buildAgentAwarenessPrompt(actor, { allowedDriveIds: ['allowed'] });
    expect(prompt).toContain('Allowed agent');
    expect(prompt).not.toContain('Outside workspace');
    expect(prompt).not.toContain('Outside agent');
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(getUserDriveAccess).toHaveBeenCalledTimes(1);
    expect(getUserDriveAccess).toHaveBeenCalledWith(actor, 'allowed');
    expect(canUserViewPage).toHaveBeenCalledWith(actor, 'agent');
  });

  it('Given an unscoped credential, should retain agent discovery in every reachable drive', async () => {
    const prompt = await buildAgentAwarenessPrompt(actor, { allowedDriveIds: [] });
    expect(prompt).toContain('Allowed workspace');
    expect(prompt).toContain('Outside workspace');
    expect(prompt).toContain('Outside agent');
    expect(getUserDriveAccess).toHaveBeenCalledTimes(2);
  });

  it('Given an allowed drive whose credential access is refused, should disclose no workspace or agent', async () => {
    vi.mocked(getUserDriveAccess).mockResolvedValue(false);
    expect(await getDriveListSummary(actor, { allowedDriveIds: ['allowed'] })).toBe('No accessible workspaces.');
    expect(await buildAgentAwarenessPrompt(actor, { allowedDriveIds: ['allowed'] })).toBe('');
    expect(canUserViewPage).not.toHaveBeenCalled();
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);
  });

  it('Given an outside-scope tree request, should read no drive or page data', async () => {
    const tree = await getPageTreeContext(actor, { scope: 'drive', driveId: 'outside', allowedDriveIds: ['allowed'] });
    expect(tree).toBe('');
    expect(db.select).not.toHaveBeenCalled();
    expect(getUserDriveAccess).not.toHaveBeenCalled();
  });
});
