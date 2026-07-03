import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import { createRegistry, getOperation, hasOperation, listOperations } from '../registry.js';

function op(name: string) {
  return defineOperation({
    name,
    method: 'GET' as const,
    path: '/api/widgets',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    description: `Operation ${name}.`,
  });
}

describe('createRegistry — duplicate rejection', () => {
  it('throws at construction when two operations share a name', () => {
    expect(() => createRegistry([op('drives.list'), op('drives.list')])).toThrow(/drives\.list/);
  });

  it('does not throw for distinct names', () => {
    expect(() => createRegistry([op('drives.list'), op('pages.read')])).not.toThrow();
  });

  it('constructs an empty registry without throwing', () => {
    expect(() => createRegistry([])).not.toThrow();
  });
});

describe('createRegistry — lookup', () => {
  it('getOperation finds a registered operation by name', () => {
    const registry = createRegistry([op('drives.list'), op('pages.read')]);
    expect(getOperation(registry, 'pages.read')?.name).toBe('pages.read');
  });

  it('getOperation returns undefined for an unregistered name', () => {
    const registry = createRegistry([op('drives.list')]);
    expect(getOperation(registry, 'nope')).toBeUndefined();
  });

  it('hasOperation reflects registered names', () => {
    const registry = createRegistry([op('drives.list')]);
    expect(hasOperation(registry, 'drives.list')).toBe(true);
    expect(hasOperation(registry, 'pages.read')).toBe(false);
  });
});

describe('createRegistry — iteration', () => {
  it('listOperations exposes every registered operation', () => {
    const registry = createRegistry([op('drives.list'), op('pages.read')]);
    const names = listOperations(registry)
      .map((o) => o.name)
      .sort();
    expect(names).toEqual(['drives.list', 'pages.read']);
  });

  it('listOperations reflects registration order', () => {
    const registry = createRegistry([op('b'), op('a'), op('c')]);
    expect(listOperations(registry).map((o) => o.name)).toEqual(['b', 'a', 'c']);
  });
});

describe('createRegistry — immutability', () => {
  it('mutating the returned operations list does not affect subsequent lookups', () => {
    const registry = createRegistry([op('drives.list')]);
    const ops = listOperations(registry);
    expect(() => {
      (ops as unknown as unknown[]).push(op('pages.read'));
    }).toThrow();
  });
});
