/**
 * Security: the processor's service token is minted for the person driving the
 * turn and re-checked against that same person, while canActorViewPage may have
 * authorized a page agent through its own drive membership. File bytes are only
 * fetched when BOTH can view the page; otherwise no token is minted at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  canActorViewPage: vi.fn(),
  getUserAccessLevel: vi.fn(),
  createPageServiceToken: vi.fn(),
}));

vi.mock('../actor-permissions', () => ({
  canActorViewPage: mocks.canActorViewPage,
  toolActor: (context: { accessActor: unknown }) => context.accessActor,
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ getUserAccessLevel: mocks.getUserAccessLevel }));
vi.mock('@pagespace/lib/services/validated-service-token', () => ({ createPageServiceToken: mocks.createPageServiceToken }));

import { fileBytesFetcherFor } from '../processor-file-fetch-runtime';
import type { ToolExecutionContext } from '../../core/types';

const context = { userId: 'user-1', accessActor: { userId: 'user-1' } } as unknown as ToolExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createPageServiceToken.mockResolvedValue({ token: 'svc' });
});

describe('fileBytesFetcherFor', () => {
  it('refuses when the agent can view the page but its user cannot, minting nothing', async () => {
    mocks.canActorViewPage.mockResolvedValue(true);
    mocks.getUserAccessLevel.mockResolvedValue({ canView: false });

    expect(await fileBytesFetcherFor(context, 'page-b')).toBeNull();
    expect(mocks.createPageServiceToken).not.toHaveBeenCalled();
  });

  it('refuses when the user can view the page but the acting agent cannot', async () => {
    mocks.canActorViewPage.mockResolvedValue(false);
    mocks.getUserAccessLevel.mockResolvedValue({ canView: true });

    expect(await fileBytesFetcherFor(context, 'page-b')).toBeNull();
    expect(mocks.createPageServiceToken).not.toHaveBeenCalled();
  });

  it('refuses when the user has no access record at all', async () => {
    mocks.canActorViewPage.mockResolvedValue(true);
    mocks.getUserAccessLevel.mockResolvedValue(null);

    expect(await fileBytesFetcherFor(context, 'page-b')).toBeNull();
  });

  it('returns a fetcher when both can view, and mints a files:read token for the page on first use', async () => {
    mocks.canActorViewPage.mockResolvedValue(true);
    mocks.getUserAccessLevel.mockResolvedValue({ canView: true });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }));

    const fetcher = await fileBytesFetcherFor(context, 'page-b');
    expect(fetcher).not.toBeNull();
    await fetcher!('a'.repeat(64), 'ai-vision');

    expect(mocks.createPageServiceToken).toHaveBeenCalledWith(context.accessActor, 'page-b', ['files:read'], '5m');
    expect(mocks.canActorViewPage).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});
