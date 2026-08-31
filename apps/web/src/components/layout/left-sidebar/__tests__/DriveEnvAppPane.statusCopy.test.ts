/**
 * `statusCopyFor` must degrade to a generic fallback on a status value the UI
 * doesn't know about, rather than crashing on an undefined lookup — the
 * `published_app_status` enum can grow a value before every reader is updated,
 * and that must never white-screen the sidebar.
 */

import { describe, it, expect } from 'vitest';
import { statusCopyFor } from '../DriveEnvAppPane';
import type { PublishedAppStatus } from '@/hooks/drive-envs/useDriveEnvApp';

describe('statusCopyFor', () => {
  it('returns the mapped copy for every known status', () => {
    const known: PublishedAppStatus[] = [
      'provisioning',
      'building',
      'deploying',
      'running',
      'stopped',
      'parked',
      'destroying',
      'failed',
    ];
    for (const status of known) {
      const copy = statusCopyFor(status);
      expect(copy.label.length).toBeGreaterThan(0);
    }
  });

  it('falls back to a generic entry for an unmapped status instead of throwing', () => {
    const unknownStatus = 'some_future_status' as PublishedAppStatus;
    expect(() => statusCopyFor(unknownStatus)).not.toThrow();
    const copy = statusCopyFor(unknownStatus);
    expect(copy.label).toBe('some_future_status');
    expect(copy.tone).toBe('outline');
  });
});
