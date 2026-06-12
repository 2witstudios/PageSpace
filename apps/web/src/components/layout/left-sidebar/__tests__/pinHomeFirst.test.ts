import { describe, it, expect } from 'vitest';
import { pinHomeFirst } from '../DriveList';
import type { Drive } from '@/hooks/useDrive';

function makeDrive(overrides: Partial<Drive>): Drive {
  return {
    id: 'id',
    name: 'Drive',
    slug: 'drive',
    role: 'OWNER',
    isOwned: true,
    isTrashed: false,
    memberCount: 1,
    ...overrides,
  } as Drive;
}

describe('pinHomeFirst', () => {
  it('puts the Home drive first when it exists in the list', () => {
    const a = makeDrive({ id: 'a', name: 'Alpha', kind: 'STANDARD' });
    const h = makeDrive({ id: 'h', name: 'Home', kind: 'HOME' });
    const b = makeDrive({ id: 'b', name: 'Beta', kind: 'STANDARD' });

    const result = pinHomeFirst([a, h, b]);
    expect(result[0].id).toBe('h');
    expect(result.map(d => d.id)).toEqual(['h', 'a', 'b']);
  });

  it('preserves original order when no Home drive is present', () => {
    const a = makeDrive({ id: 'a', kind: 'STANDARD' });
    const b = makeDrive({ id: 'b', kind: 'STANDARD' });
    const result = pinHomeFirst([a, b]);
    expect(result.map(d => d.id)).toEqual(['a', 'b']);
  });

  it('treats undefined kind as STANDARD (stale cache)', () => {
    const a = makeDrive({ id: 'a', kind: undefined });
    const b = makeDrive({ id: 'b', kind: undefined });
    const result = pinHomeFirst([a, b]);
    expect(result.map(d => d.id)).toEqual(['a', 'b']);
  });

  it('returns empty array for empty input', () => {
    expect(pinHomeFirst([])).toEqual([]);
  });

  it('returns a new array (does not mutate input)', () => {
    const a = makeDrive({ id: 'a', kind: 'STANDARD' });
    const h = makeDrive({ id: 'h', kind: 'HOME' });
    const original = [a, h];
    const result = pinHomeFirst(original);
    expect(result).not.toBe(original);
    expect(original[0].id).toBe('a');
  });
});
