import { describe, it, expect } from 'vitest';
import { statusBadgeLabel, statusBadgeVariant } from '../status-badge';
import type { BroadcastStatus } from '../types';

const STATUSES: BroadcastStatus[] = [
  'draft', 'pending', 'queued', 'in_progress', 'paused', 'completed', 'failed', 'cancelled',
];

describe('statusBadgeVariant / statusBadgeLabel', () => {
  it('has a mapping for every broadcast status', () => {
    for (const status of STATUSES) {
      expect(statusBadgeVariant(status)).toBeTruthy();
      expect(statusBadgeLabel(status)).toBeTruthy();
    }
  });

  it('marks failed as destructive', () => {
    expect(statusBadgeVariant('failed')).toBe('destructive');
  });

  it('marks completed and in_progress as the default (positive) variant', () => {
    expect(statusBadgeVariant('completed')).toBe('default');
    expect(statusBadgeVariant('in_progress')).toBe('default');
  });

  it('gives each status a distinct, human-readable label', () => {
    const labels = STATUSES.map(statusBadgeLabel);
    expect(new Set(labels).size).toBe(STATUSES.length);
    expect(statusBadgeLabel('in_progress')).toBe('In progress');
  });
});
