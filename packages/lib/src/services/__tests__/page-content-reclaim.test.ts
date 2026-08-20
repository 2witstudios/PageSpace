import { describe, expect, it } from 'vitest';
import { decideBlobReclaim } from '../page-content-reclaim';

const DAY = 24 * 60 * 60 * 1000;

describe('decideBlobReclaim', () => {
  it('given the last reference dropped and an old blob, deletes', () => {
    expect(
      decideBlobReclaim({ hasReferences: false, blobAgeMs: 2 * DAY, minAgeMs: DAY })
    ).toEqual({ action: 'delete' });
  });

  it('given another page still references the blob, retains it', () => {
    expect(
      decideBlobReclaim({ hasReferences: true, blobAgeMs: 30 * DAY, minAgeMs: DAY })
    ).toEqual({ action: 'retain', reason: 'still-referenced' });
  });

  it('given references from a different tenant, retains it — the store is not tenant-scoped', () => {
    expect(
      decideBlobReclaim({ hasReferences: true, blobAgeMs: 365 * DAY, minAgeMs: DAY }).action
    ).toBe('retain');
  });

  it('given a blob younger than the floor, retains it even with zero references', () => {
    // A concurrent writePageContent can be between its HEAD hit and its row
    // insert right now; the blob is not provably unreferenced.
    expect(
      decideBlobReclaim({ hasReferences: false, blobAgeMs: 1000, minAgeMs: DAY })
    ).toEqual({ action: 'retain', reason: 'too-young' });
  });

  it('given an age exactly at the floor, deletes', () => {
    expect(
      decideBlobReclaim({ hasReferences: false, blobAgeMs: DAY, minAgeMs: DAY }).action
    ).toBe('delete');
  });

  it('given an undateable blob, fails closed', () => {
    expect(
      decideBlobReclaim({ hasReferences: false, blobAgeMs: null, minAgeMs: DAY })
    ).toEqual({ action: 'retain', reason: 'age-unknown' });
  });

  it('checks references before age — a referenced blob is retained whatever its age', () => {
    expect(
      decideBlobReclaim({ hasReferences: true, blobAgeMs: null, minAgeMs: DAY })
    ).toEqual({ action: 'retain', reason: 'still-referenced' });
  });
});
