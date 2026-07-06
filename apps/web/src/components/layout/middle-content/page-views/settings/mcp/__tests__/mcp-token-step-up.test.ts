import { describe, it, expect } from 'vitest';
import { buildMintActionBinding, buildUpdateActionBinding } from '../mcp-token-step-up';
import { computeMcpTokenActionBinding } from '@pagespace/lib/auth/mcp-token-scopes';

describe('buildMintActionBinding', () => {
  it('mirrors the server’s own computeMcpTokenActionBinding for op: mint with no drive scopes', () => {
    expect(buildMintActionBinding('Claude Desktop', [], {})).toEqual(
      computeMcpTokenActionBinding({ op: 'mint', name: 'Claude Desktop', driveScopes: [] }),
    );
  });

  it('mirrors the server’s binding for a selected drive with an inherited (null) role', () => {
    expect(buildMintActionBinding('Claude Desktop', ['drive-1'], {})).toEqual(
      computeMcpTokenActionBinding({
        op: 'mint',
        name: 'Claude Desktop',
        driveScopes: [{ id: 'drive-1', role: null, customRoleId: undefined }],
      }),
    );
  });

  it('mirrors the server’s binding for an explicit role and custom role selection', () => {
    const roleSelections = { 'drive-1': { role: 'MEMBER' as const, customRoleId: 'role-support' } };
    expect(buildMintActionBinding('Claude Desktop', ['drive-1'], roleSelections)).toEqual(
      computeMcpTokenActionBinding({
        op: 'mint',
        name: 'Claude Desktop',
        driveScopes: [{ id: 'drive-1', role: 'MEMBER', customRoleId: 'role-support' }],
      }),
    );
  });

  it('is order-independent for multiple selected drives (matches the server’s own sort-before-hash)', () => {
    const forward = buildMintActionBinding('Claude Desktop', ['drive-1', 'drive-2'], {});
    const reversed = buildMintActionBinding('Claude Desktop', ['drive-2', 'drive-1'], {});
    expect(forward).toEqual(reversed);
  });
});

describe('buildUpdateActionBinding', () => {
  it('mirrors the server’s own computeMcpTokenActionBinding for op: update, using the tokenId as the name slot', () => {
    expect(buildUpdateActionBinding('token-1', ['drive-2'], {})).toEqual(
      computeMcpTokenActionBinding({
        op: 'update',
        name: 'token-1',
        driveScopes: [{ id: 'drive-2', role: null, customRoleId: undefined }],
      }),
    );
  });

  it('produces a different binding than a mint request with the same drive scopes (op discriminates)', () => {
    const mint = buildMintActionBinding('token-1', ['drive-2'], {});
    const update = buildUpdateActionBinding('token-1', ['drive-2'], {});
    expect(mint).not.toEqual(update);
  });

  it('produces an explicit empty-drive-scopes binding when no drives are selected', () => {
    expect(buildUpdateActionBinding('token-1', [], {})).toEqual(
      computeMcpTokenActionBinding({ op: 'update', name: 'token-1', driveScopes: [] }),
    );
  });
});
