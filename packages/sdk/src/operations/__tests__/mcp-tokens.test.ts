import { describe, expect, it } from 'vitest';
import { listMcpTokens, revokeMcpToken } from '../mcp-tokens.js';

// There is deliberately no `tokens.create` operation: the server mints keys
// via session-only auth (OAuth consent flow / web UI), which the SDK's
// Bearer-only transport can never satisfy. See the module doc header.

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
