import { describe, expect, it } from 'vitest';
import { heldAssetCount } from '../held-assets';

describe('heldAssetCount', () => {
  it('counts held file IDs and tolerates other shapes', () => {
    expect(heldAssetCount({ heldAssets: ['a', 'b'] })).toBe(2);
    expect(heldAssetCount({ heldAssets: [] })).toBe(0);
    expect(heldAssetCount({ url: 'x' })).toBe(0);
    expect(heldAssetCount(null)).toBe(0);
    expect(heldAssetCount({ heldAssets: 'nope' })).toBe(0);
  });
});
