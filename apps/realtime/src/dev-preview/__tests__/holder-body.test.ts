import { describe, it, expect } from 'vitest';
import { readDevPreviewHolderBody } from '../holder-body';

describe('readDevPreviewHolderBody', () => {
  it('reads exactly the holder and drops everything else in the body', () => {
    expect(readDevPreviewHolderBody(JSON.stringify({ holder: { kind: 'env', id: 'env1' }, sandboxId: 'claim' }))).toEqual({ kind: 'env', id: 'env1' });
    expect(readDevPreviewHolderBody(JSON.stringify({ holder: { kind: 'workspace', id: 'ws1' } }))).toEqual({ kind: 'workspace', id: 'ws1' });
  });

  it.each([
    'not json',
    'null',
    '"str"',
    JSON.stringify({}),
    JSON.stringify({ holder: null }),
    JSON.stringify({ holder: 'env' }),
    JSON.stringify({ holder: { kind: 'drive', id: 'x' } }),
    JSON.stringify({ holder: { kind: 'env', id: '' } }),
    JSON.stringify({ holder: { kind: 'env', id: 7 } }),
    JSON.stringify({ holder: { kind: 'env' } }),
  ])('rejects a malformed body (%s)', (body) => {
    expect(readDevPreviewHolderBody(body)).toBeNull();
  });
});
