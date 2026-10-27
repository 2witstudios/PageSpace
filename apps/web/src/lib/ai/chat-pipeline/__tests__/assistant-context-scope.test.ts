// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';

vi.mock('@/lib/ai/core/personalization-utils', () => ({ getUserPersonalization: vi.fn(async () => ({})), getUserTimezone: vi.fn(async () => 'UTC') }));
vi.mock('@/lib/ai/core/home-drive-hint', () => ({ resolveHomeDriveHint: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai/core/agent-awareness', () => ({ buildAgentAwarenessPrompt: vi.fn(async () => '') }));
vi.mock('@/lib/ai/core/page-tree-context', () => ({ getPageTreeContext: vi.fn(async () => 'Allowed tree'), getDriveListSummary: vi.fn(async () => 'Allowed summary') }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ getUserDriveAccess: vi.fn(async () => true) }));
vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [{ drivePrompt: 'Allowed instructions' }] }) }) })) } }));

import { buildAssistantContext } from '../assistant-surface';
import { buildAgentAwarenessPrompt } from '@/lib/ai/core/agent-awareness';
import { getPageTreeContext, getDriveListSummary } from '@/lib/ai/core/page-tree-context';
import { getUserDriveAccess } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';

const actor = credentialActor('owner', { authenticatedAtMs: Date.now(), assurance: 'user_verified_passkey' });
const input = { actor, readOnly: false, showPageTree: true, allowedDriveIds: ['allowed'] };
const location = (id: string) => ({ currentDrive: { id, name: `${id} workspace`, slug: id }, currentPage: { id: `${id}-page`, title: `${id} title`, type: 'DOCUMENT', path: `${id}/secret` }, breadcrumbs: [`${id} breadcrumb`] });

beforeEach(() => vi.clearAllMocks());

describe('assistant context credential drive ceiling', () => {
  it('Given an outside-scope legacy location, should disclose no title, path, prompt or tree and read no arbitrary drive', async () => {
    const result = await buildAssistantContext({ ...input, location: location('outside') });
    expect(JSON.stringify(result)).not.toContain('outside');
    expect(result.drivePromptSection).toBe('');
    expect(db.select).not.toHaveBeenCalled();
    expect(getUserDriveAccess).not.toHaveBeenCalled();
    expect(getPageTreeContext).not.toHaveBeenCalled();
    expect(buildAgentAwarenessPrompt).toHaveBeenCalledWith(actor, expect.objectContaining({ allowedDriveIds: ['allowed'] }));
    expect(getDriveListSummary).toHaveBeenCalledWith(actor, expect.objectContaining({ allowedDriveIds: ['allowed'] }));
  });

  it('Given a page-only legacy hint with no scope-verifiable drive, should disclose no page title or path', async () => {
    const result = await buildAssistantContext({ ...input, location: { currentPage: location('outside').currentPage } });
    expect(JSON.stringify(result)).not.toContain('outside');
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each([{ allowedDriveIds: ['allowed'] }, { allowedDriveIds: [] }])('Given a permitted location with scope %j, should preserve context and credential-aware access', async ({ allowedDriveIds }) => {
    const result = await buildAssistantContext({ ...input, allowedDriveIds, location: location('allowed') });
    expect(result.locationPrompt).toContain('allowed title');
    expect(result.drivePromptSection).toContain('Allowed instructions');
    expect(result.pageTreePrompt).toContain('Allowed tree');
    expect(getUserDriveAccess).toHaveBeenCalledWith(actor, 'allowed');
    expect(getPageTreeContext).toHaveBeenCalledWith(actor, expect.objectContaining({ driveId: 'allowed', allowedDriveIds }));
  });
});
