import { describe, it, expect } from 'vitest';
import {
  compareByPagePosition,
  computeTaskMovePosition,
  type OrderedTaskLike,
  type TaskPeer,
} from '../task-ordering';

const task = (id: string, position: number | null): OrderedTaskLike => ({
  id,
  page: position === null ? null : { position },
});

const peers = (...entries: Array<[string, number]>): TaskPeer[] =>
  entries.map(([id, position]) => ({ id, position }));

describe('compareByPagePosition', () => {
  it('orders ascending by page position', () => {
    expect(compareByPagePosition(task('a', 1), task('b', 2), 'asc')).toBeLessThan(0);
    expect(compareByPagePosition(task('a', 2), task('b', 1), 'asc')).toBeGreaterThan(0);
  });

  it('orders descending when sortOrder is desc', () => {
    expect(compareByPagePosition(task('a', 1), task('b', 2), 'desc')).toBeGreaterThan(0);
    expect(compareByPagePosition(task('a', 2), task('b', 1), 'desc')).toBeLessThan(0);
  });

  it('defaults to ascending when sortOrder is omitted', () => {
    expect(compareByPagePosition(task('a', 1), task('b', 2))).toBeLessThan(0);
  });

  it('breaks position ties on id, ascending in both sort directions', () => {
    // The id tiebreaker mirrors the SQL `asc(taskItems.id)` tiebreaker: it exists to make
    // paging stable, so it must NOT flip with sortOrder.
    expect(compareByPagePosition(task('a', 5), task('b', 5), 'asc')).toBeLessThan(0);
    expect(compareByPagePosition(task('a', 5), task('b', 5), 'desc')).toBeLessThan(0);
    expect(compareByPagePosition(task('b', 5), task('a', 5), 'asc')).toBeGreaterThan(0);
  });

  it('returns 0 for the same id at the same position', () => {
    expect(compareByPagePosition(task('a', 5), task('a', 5), 'asc')).toBe(0);
  });

  it('sorts rows with a missing page last in ascending order', () => {
    // A task whose page relation failed to hydrate has no position at all; it must not
    // silently sort to slot 0 (the old `?? task.position` fallback's behaviour).
    expect(compareByPagePosition(task('a', null), task('b', 1), 'asc')).toBeGreaterThan(0);
    expect(compareByPagePosition(task('a', 1), task('b', null), 'asc')).toBeLessThan(0);
  });

  it('keeps missing-page rows last in descending order too', () => {
    expect(compareByPagePosition(task('a', null), task('b', 1), 'desc')).toBeGreaterThan(0);
    expect(compareByPagePosition(task('a', 1), task('b', null), 'desc')).toBeLessThan(0);
  });

  it('falls back to the id tiebreaker when both pages are missing', () => {
    expect(compareByPagePosition(task('a', null), task('b', null), 'asc')).toBeLessThan(0);
  });

  it('sorts a list end-to-end', () => {
    const list = [task('c', 3), task('a', 1), task('d', 2), task('b', 2)];
    expect([...list].sort((x, y) => compareByPagePosition(x, y, 'asc')).map(t => t.id))
      .toEqual(['a', 'b', 'd', 'c']);
    expect([...list].sort((x, y) => compareByPagePosition(x, y, 'desc')).map(t => t.id))
      .toEqual(['c', 'b', 'd', 'a']);
  });
});

describe('computeTaskMovePosition', () => {
  it('places the only task at position 0 when the list is otherwise empty', () => {
    expect(computeTaskMovePosition({ peers: [], movedId: 'x', targetIndex: 0 }))
      .toEqual({ kind: 'single', position: 0, index: 0 });
  });

  it('ignores the moved task when it is already among the peers', () => {
    // peers come straight from a "children of this list" query, which includes the mover.
    const result = computeTaskMovePosition({
      peers: peers(['a', 1], ['x', 2], ['b', 3]),
      movedId: 'x',
      targetIndex: 0,
    });
    expect(result).toEqual({ kind: 'single', position: 0, index: 0 });
  });

  it('moves before the first peer by stepping one below it', () => {
    expect(computeTaskMovePosition({ peers: peers(['a', 4], ['b', 8]), movedId: 'x', targetIndex: 0 }))
      .toEqual({ kind: 'single', position: 3, index: 0 });
  });

  it('moves after the last peer by stepping one above it', () => {
    expect(computeTaskMovePosition({ peers: peers(['a', 4], ['b', 8]), movedId: 'x', targetIndex: 2 }))
      .toEqual({ kind: 'single', position: 9, index: 2 });
  });

  it('splits the gap between two peers', () => {
    expect(computeTaskMovePosition({ peers: peers(['a', 4], ['b', 8]), movedId: 'x', targetIndex: 1 }))
      .toEqual({ kind: 'single', position: 6, index: 1 });
  });

  it('clamps a negative target index to the first slot', () => {
    expect(computeTaskMovePosition({ peers: peers(['a', 4]), movedId: 'x', targetIndex: -5 }))
      .toEqual({ kind: 'single', position: 3, index: 0 });
  });

  it('clamps an oversized target index to the last slot', () => {
    expect(computeTaskMovePosition({ peers: peers(['a', 4]), movedId: 'x', targetIndex: 99 }))
      .toEqual({ kind: 'single', position: 5, index: 1 });
  });

  it('truncates a fractional target index', () => {
    expect(computeTaskMovePosition({ peers: peers(['a', 4], ['b', 8]), movedId: 'x', targetIndex: 1.9 }))
      .toEqual({ kind: 'single', position: 6, index: 1 });
  });

  it('densifies when the float4 gap between neighbours can no longer be split', () => {
    // Two positions one float4 ULP apart: no representable value sits between them, so a
    // midpoint write would silently land on a neighbour and duplicate its position.
    const lo = Math.fround(1.5);
    const hi = nextFloat32Above(lo);
    const result = computeTaskMovePosition({
      peers: peers(['a', lo], ['b', hi], ['c', 100]),
      movedId: 'x',
      targetIndex: 1,
    });
    expect(result).toEqual({
      kind: 'densify',
      index: 1,
      positions: [
        { id: 'a', position: 0 },
        { id: 'x', position: 1 },
        { id: 'b', position: 2 },
        { id: 'c', position: 3 },
      ],
    });
  });

  it('densifies when two peers already share the same position', () => {
    const result = computeTaskMovePosition({
      peers: peers(['a', 7], ['b', 7]),
      movedId: 'x',
      targetIndex: 1,
    });
    expect(result).toEqual({
      kind: 'densify',
      index: 1,
      positions: [
        { id: 'a', position: 0 },
        { id: 'x', position: 1 },
        { id: 'b', position: 2 },
      ],
    });
  });

  it('does not densify at the boundaries even when neighbouring positions are dense', () => {
    const lo = Math.fround(1.5);
    const hi = nextFloat32Above(lo);
    expect(computeTaskMovePosition({ peers: peers(['a', lo], ['b', hi]), movedId: 'x', targetIndex: 0 }))
      .toEqual({ kind: 'single', position: lo - 1, index: 0 });
    expect(computeTaskMovePosition({ peers: peers(['a', lo], ['b', hi]), movedId: 'x', targetIndex: 2 }))
      .toEqual({ kind: 'single', position: hi + 1, index: 2 });
  });
});

/** Smallest float32 strictly greater than `value` — used to build an unsplittable gap. */
function nextFloat32Above(value: number): number {
  const buffer = new Float32Array(1);
  buffer[0] = value;
  const bits = new Uint32Array(buffer.buffer);
  bits[0] += 1;
  return buffer[0];
}
