// @vitest-environment node
/**
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * The client used to hand-declare its own copy of this endpoint's row shape
 * saying `sessionId`, while the server had been renamed to `workspaceId`.
 * Every test on both sides passed, because each side's fixtures were written
 * against its OWN hand-declaration — consistent with each other, and wrong
 * about the wire. In production `row.sessionId` was `undefined` on every row,
 * so an already-bound conversation never resolved to `pane`, its claim 409'd,
 * and clicking history ejected the user to `/dashboard`.
 *
 * So this test refuses to hand-declare anything. It drives the REAL route
 * handler, takes the REAL JSON off its response, and hands that to the REAL
 * `resolveNavigationTarget` the click path uses. The only thing it fixes by
 * hand is what the DB layer returns — and that value is typed
 * `PastConversationServerRow`, so it cannot drift from the server either.
 *
 * Reintroduce the mismatch in any single place and this goes red at runtime,
 * where the type system could not see it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockListAllConversationsPaginated,
  mockGetBatchPagePermissions,
  mockResolveDriveMembership,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockListAllConversationsPaginated: vi.fn(),
  mockGetBatchPagePermissions: vi.fn(),
  mockResolveDriveMembership: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn() } },
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getBatchPagePermissions: (...args: unknown[]) => mockGetBatchPagePermissions(...args),
}));
vi.mock('@pagespace/lib/services/agent-workspaces/agent-workspace-tenant', () => ({
  resolveDriveMembership: (...args: unknown[]) => mockResolveDriveMembership(...args),
}));
// Only the DB read is mocked. Everything from the route's serialization
// outward — including `NextResponse.json`'s `Date` → ISO-string handling — is
// the real thing, which is exactly the boundary that broke.
vi.mock('@/lib/agent-workspaces/workspace-conversations-runtime', () => ({
  listAllConversationsPaginated: (...args: unknown[]) => mockListAllConversationsPaginated(...args),
  encodeCursor: (sortKey: Date | string, id: string) =>
    Buffer.from(JSON.stringify({ sortKey: new Date(sortKey).toISOString(), id })).toString('base64url'),
}));

import { GET } from '../route';
import { resolveNavigationTarget } from '@/components/agents/resolveNavigationTarget';
import type { toWireRow } from '@/lib/agent-workspaces/past-conversation-dto';
import type {
  PastConversationDTO,
  PastConversationServerRow,
  PastConversationsResponseDTO,
} from '@/lib/agent-workspaces/past-conversation-dto';

/* ------------------------------------------------------------------ *
 * Type-level half: the serialized server row IS the client's DTO.
 * Checked by `bun run typecheck` (apps/web's tsconfig includes tests).
 * ------------------------------------------------------------------ */

/** What `NextResponse.json` does to a row: every `Date` becomes an ISO string. */
type Serialized<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};
/** Collapses an intersection into a plain object type so the two sides compare structurally. */
type Flatten<T> = { [K in keyof T]: T[K] };
/** Declaring one of these is the assertion: a violated `extends` is a compile error. */
type Assignable<_A extends _B, _B> = true;

/**
 * The client narrows `type` to `ConversationKind`; the server leaves it the
 * plain `string` the `conversations.type` text column hands back. That one
 * widening is the ONLY licensed difference — everything else, field names
 * above all, must agree in both directions (assignability one way catches a
 * missing field, the other way catches an extra one).
 */
type WireDTOWithRawType = Flatten<Omit<PastConversationDTO, 'type'> & { type: string }>;
// What actually goes out is `toWireRow`'s OUTPUT, not the raw server row: the
// row carries a server-only `sortKeyValue` (the ordering key the route mints
// its cursor from) that the strip removes. Tying the contract to the function's
// return type rather than re-stating the omission here means a field added to
// the row and forgotten in the strip is still a compile error — and that the
// strip itself cannot silently start dropping something the client needs.
type SerializedServerRow = Flatten<Serialized<ReturnType<typeof toWireRow>>>;

type _ServerRowFitsTheWireDTO = Assignable<SerializedServerRow, WireDTOWithRawType>;
type _WireDTOFitsTheServerRow = Assignable<WireDTOWithRawType, SerializedServerRow>;

/* ------------------------------------------------------------------ *
 * Runtime half: real route → real JSON → real navigation decision.
 * ------------------------------------------------------------------ */

const AUTH = { userId: 'user-1', role: 'user' };

/** Typed as the SERVER's row, so a rename there breaks this fixture too. */
const BOUND_PAGE_ROW: PastConversationServerRow = {
  conversationId: 'conv-bound',
  title: 'Live chat',
  type: 'page',
  agentPageId: 'agent-1',
  pageTitle: 'Researcher',
  lastMessageAt: new Date('2026-07-28T00:00:00.000Z'),
  createdAt: new Date('2026-07-27T00:00:00.000Z'),
  workspaceId: 'workspace-1',
  sessionName: 'Worker',
  sessionEndedAt: null,
  driveId: 'drive-1',
  sortKeyValue: '2026-07-28 00:00:00.000000',
};

const UNBOUND_GLOBAL_ROW: PastConversationServerRow = {
  conversationId: 'conv-global',
  title: null,
  type: 'global',
  agentPageId: null,
  pageTitle: null,
  lastMessageAt: new Date('2026-07-26T00:00:00.000Z'),
  createdAt: new Date('2026-07-26T00:00:00.000Z'),
  workspaceId: null,
  sessionName: null,
  sessionEndedAt: null,
  driveId: null,
  sortKeyValue: '2026-07-26 00:00:00.000000',
};

async function fetchRows(): Promise<PastConversationDTO[]> {
  const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations'));
  expect(response.status).toBe(200);
  const body = (await response.json()) as PastConversationsResponseDTO;
  return body.conversations;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH);
  mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: true }]]));
  mockResolveDriveMembership.mockResolvedValue('member');
  mockListAllConversationsPaginated.mockResolvedValue({
    conversations: [BOUND_PAGE_ROW, UNBOUND_GLOBAL_ROW],
    pagination: { hasMore: false, nextCursor: null, limit: 20 },
  });
});

describe('past-conversations wire contract', () => {
  it('puts the workspace binding on the wire under the name the client reads', async () => {
    const [bound, unbound] = await fetchRows();

    // The assertion the old code could not have passed: the property the
    // client's navigation actually reads is present and carries the id.
    expect(bound.workspaceId).toBe('workspace-1');
    expect(unbound.workspaceId).toBeNull();
    // ...and nothing on the wire is called `sessionId`. A server that renamed
    // it back would satisfy the line above only by ALSO sending the old name.
    expect(Object.keys(bound)).not.toContain('sessionId');
  });

  it('a real wire row for a workspace-bound conversation resolves to a pane, not a claim', async () => {
    const [bound] = await fetchRows();

    // No re-typing, no fixture: the object the browser would receive, handed
    // to the function the click handler calls.
    expect(resolveNavigationTarget(bound, undefined)).toEqual({
      kind: 'pane',
      sessionId: 'workspace-1',
      conversationId: 'conv-bound',
      agentId: 'agent-1',
    });
  });

  it('a real wire row for an unbound conversation still resolves to a claim', async () => {
    const [, unbound] = await fetchRows();

    expect(resolveNavigationTarget(unbound, 'drive-current')).toEqual({
      kind: 'claimable',
      conversationId: 'conv-global',
      agentPageId: null,
      driveId: 'drive-current',
      fallback: { kind: 'global', conversationId: 'conv-global', driveId: 'drive-current' },
    });
  });

  it('serializes timestamps as strings, as the client DTO declares them', async () => {
    const [bound] = await fetchRows();

    expect(bound.lastMessageAt).toBe('2026-07-28T00:00:00.000Z');
    expect(bound.createdAt).toBe('2026-07-27T00:00:00.000Z');
  });
});
