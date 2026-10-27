import { describe, it, expect } from 'vitest';
import { orgBacklogStart } from '../org-compute-epoch-core';

const at = (iso: string) => new Date(iso);

describe('orgBacklogStart', () => {
  it('WAL-9 (partial) an org row whose watermark predates org billing starts its billable window at the epoch — the backlog is forgiven', () => {
    expect(orgBacklogStart({ watermark: at('2026-06-01T00:00:00Z'), epoch: at('2026-09-28T12:00:00Z') })).toEqual(at('2026-09-28T12:00:00Z'));
  });

  it('a watermark at the epoch forgives nothing', () => {
    expect(orgBacklogStart({ watermark: at('2026-09-28T12:00:00Z'), epoch: at('2026-09-28T12:00:00Z') })).toBeNull();
  });

  it('a watermark after the epoch (a new or moved-in row, or a second tick) forgives nothing', () => {
    expect(orgBacklogStart({ watermark: at('2026-09-29T00:00:00Z'), epoch: at('2026-09-28T12:00:00Z') })).toBeNull();
  });
});
