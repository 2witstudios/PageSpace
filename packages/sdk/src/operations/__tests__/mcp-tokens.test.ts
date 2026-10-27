import { describe, expect, it } from 'vitest';
import { describeSelfKey, listMcpTokens, revokeMcpToken } from '../mcp-tokens.js';

// There is deliberately no `tokens.create` operation: the server mints keys
// via session auth only, and no SDK-supported credential (`mcp_` API keys,
// `ps_at_` OAuth access tokens) satisfies that. See the module doc header.

describe('listMcpTokens', () => {
  it('is a GET with no input fields', () => {
    expect(listMcpTokens.method).toBe('GET');
    expect(listMcpTokens.path).toBe('/api/auth/mcp-tokens');
    const parsed = listMcpTokens.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('validates a list of token summaries with a prefix, never a full token field', () => {
    const parsed = listMcpTokens.outputSchema.safeParse([
      {
        id: 't1',
        name: 'n',
        tokenPrefix: 'mcp_abcdefghijk',
        lastUsed: null,
        createdAt: '2026-07-03T00:00:00.000Z',
        isScoped: false,
        driveScopes: [],
      },
    ]);
    expect(parsed.success).toBe(true);
  });

  it('structurally strips a token field even if a buggy/compromised server included one', () => {
    const parsed = listMcpTokens.outputSchema.safeParse([
      {
        id: 't1',
        name: 'n',
        tokenPrefix: 'mcp_abcdefghijk',
        lastUsed: null,
        createdAt: '2026-07-03T00:00:00.000Z',
        isScoped: false,
        driveScopes: [],
        token: 'mcp_should_never_survive_parsing',
      },
    ]);
    expect(parsed.success).toBe(true);
    expect(parsed.success && (parsed.data[0] as Record<string, unknown>).token).toBeUndefined();
  });

  // Issue #2470: the server has always returned these three fields
  // (`sessionRepository.findUserMcpTokensWithDrives`); the schema not declaring
  // them meant zod stripped the answer to "what can this key do" before the CLI
  // could print it.
  it('carries each drive scope\'s role, so `keys list` can show what a key was granted', () => {
    const parsed = listMcpTokens.outputSchema.safeParse([
      {
        id: 't1',
        name: 'n',
        tokenPrefix: 'mcp_abcdefghijk',
        lastUsed: null,
        createdAt: '2026-07-03T00:00:00.000Z',
        isScoped: true,
        driveScopes: [
          { id: 'd1', name: 'Engineering', role: 'MEMBER', customRoleId: null, customRoleName: null },
          { id: 'd2', name: 'Research', role: null, customRoleId: 'r1', customRoleName: 'Researcher' },
        ],
      },
    ]);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data[0].driveScopes[0].role).toBe('MEMBER');
    expect(parsed.success && parsed.data[0].driveScopes[1].customRoleName).toBe('Researcher');
  });

  // An older server predates the role fields. Defaulting to null keeps that
  // response parsing rather than failing the whole command on a display detail.
  it('defaults the role fields to null when an older server omits them', () => {
    const parsed = listMcpTokens.outputSchema.safeParse([
      {
        id: 't1',
        name: 'n',
        tokenPrefix: 'mcp_abcdefghijk',
        lastUsed: null,
        createdAt: '2026-07-03T00:00:00.000Z',
        isScoped: true,
        driveScopes: [{ id: 'd1', name: 'Engineering' }],
      },
    ]);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data[0].driveScopes[0]).toEqual({
      id: 'd1',
      name: 'Engineering',
      role: null,
      customRoleId: null,
      customRoleName: null,
    });
  });
});

describe('describeSelfKey', () => {
  it('is a GET addressed at the credential itself, with an optional page to resolve alongside', () => {
    expect(describeSelfKey.method).toBe('GET');
    expect(describeSelfKey.path).toBe('/api/auth/key');
    expect(describeSelfKey.inputSchema.safeParse({}).success).toBe(true);
    expect(describeSelfKey.inputSchema.safeParse({ pageId: 'p1' }).success).toBe(true);
  });

  // A drive grants edit to any membership while a document inside it can be
  // view-only for the same key — the "reads fine, every write fails" shape of
  // #2470. `page` carries that second answer; `permissions: null` there means
  // the page is out of reach entirely, which is not the same as all-denied.
  it('carries an optional page resolution distinct from the drive\'s', () => {
    const base = {
      credential: { type: 'mcp', scoped: true, id: 'k1', name: 'a', tokenPrefix: 'mcp_a', createdAt: 'x', lastUsed: null },
      driveScopes: [],
    };
    expect(describeSelfKey.outputSchema.safeParse({ ...base }).success).toBe(true);
    expect(describeSelfKey.outputSchema.safeParse({ ...base }).data?.page).toBeNull();
    const resolved = describeSelfKey.outputSchema.safeParse({
      ...base,
      page: { id: 'p1', permissions: { canView: true, canEdit: false, canShare: false, canDelete: false } },
    });
    expect(resolved.success && resolved.data.page?.permissions?.canEdit).toBe(false);
    const unreachable = describeSelfKey.outputSchema.safeParse({ ...base, page: { id: 'p1', permissions: null } });
    expect(unreachable.success && unreachable.data.page?.permissions).toBeNull();
  });

  it('carries the RESOLVED permissions per drive, not just the granted role', () => {
    const parsed = describeSelfKey.outputSchema.safeParse({
      credential: {
        type: 'mcp',
        scoped: true,
        id: 'k1',
        name: 'agent',
        tokenPrefix: 'mcp_abcdefghijk',
        createdAt: '2026-07-03T00:00:00.000Z',
        lastUsed: null,
      },
      driveScopes: [
        {
          id: 'd1',
          name: 'Engineering',
          role: 'MEMBER',
          customRoleId: null,
          customRoleName: null,
          roleSource: 'explicit',
          permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
        },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.driveScopes[0].permissions).toEqual({
      canView: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
    });
  });

  // A key must never learn who owns it — `/api/auth/me` refuses mcp_* tokens for
  // exactly this reason, and this operation must not become the way around it.
  it('has no identity fields, and strips any a server tried to add', () => {
    const parsed = describeSelfKey.outputSchema.safeParse({
      credential: {
        type: 'mcp',
        scoped: false,
        id: null,
        name: null,
        tokenPrefix: null,
        createdAt: null,
        lastUsed: null,
        email: 'ada@example.com',
        userId: 'u1',
      },
      driveScopes: [],
    });
    expect(parsed.success).toBe(true);
    const credential = parsed.success ? (parsed.data.credential as Record<string, unknown>) : {};
    expect(credential.email).toBeUndefined();
    expect(credential.userId).toBeUndefined();
  });

  it('is not destructive and declares no required scope — every credential class may ask about itself', () => {
    expect(describeSelfKey.destructive).toBeUndefined();
    expect(describeSelfKey.requiredScope).toBeUndefined();
  });
});

describe('revokeMcpToken', () => {
  it('is a destructive DELETE keyed by tokenId', () => {
    expect(revokeMcpToken.method).toBe('DELETE');
    expect(revokeMcpToken.path).toBe('/api/auth/mcp-tokens/:tokenId');
    expect(revokeMcpToken.destructive).toBe(true);
  });

  it('validates the revoke response shape', () => {
    const parsed = revokeMcpToken.outputSchema.safeParse({ message: 'Token revoked successfully' });
    expect(parsed.success).toBe(true);
  });
});
