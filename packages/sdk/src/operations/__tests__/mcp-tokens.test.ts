import { describe, expect, it } from 'vitest';
import { createMcpToken, listMcpTokens, revokeMcpToken } from '../mcp-tokens.js';

describe('createMcpToken', () => {
  it('POSTs to /api/auth/mcp-tokens with account scope', () => {
    expect(createMcpToken.method).toBe('POST');
    expect(createMcpToken.path).toBe('/api/auth/mcp-tokens');
    expect(createMcpToken.requiredScope).toBe('account');
    expect(createMcpToken.destructive).toBeUndefined();
  });

  it('accepts a bare name with no drives (unscoped token)', () => {
    const parsed = createMcpToken.inputSchema.safeParse({ name: 'CI bot' });
    expect(parsed.success).toBe(true);
  });

  it('accepts drives with an explicit role and a customRoleId together', () => {
    const parsed = createMcpToken.inputSchema.safeParse({
      name: 'n',
      drives: [
        { id: 'd1', role: 'MEMBER' },
        { id: 'd2', role: null, customRoleId: 'r1' },
        { id: 'd3', role: 'MEMBER', customRoleId: 'r2' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a role outside the ADMIN/MEMBER enum', () => {
    const parsed = createMcpToken.inputSchema.safeParse({ name: 'n', drives: [{ id: 'd1', role: 'OWNER' }] });
    expect(parsed.success).toBe(false);
  });

  it('validates the created-token response shape, including the once-only plaintext token', () => {
    const parsed = createMcpToken.outputSchema.safeParse({
      id: 'tok_1',
      name: 'CI bot',
      token: 'mcp_plaintext_once',
      createdAt: '2026-07-03T00:00:00.000Z',
      lastUsed: null,
      driveScopes: [{ id: 'd1', name: 'Drive One' }],
    });
    expect(parsed.success).toBe(true);
  });
});

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
