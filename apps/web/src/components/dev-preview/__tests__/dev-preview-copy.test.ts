import { describe, it, expect } from 'vitest';
import { devPreviewAffordanceText, devPreviewBadge, shouldShowDevPreviewAffordance } from '../dev-preview-copy';
import type { DevPreviewStatusDTO } from '@/hooks/dev-preview/useDevPreviewStatus';

function preview(state: DevPreviewStatusDTO['state']): DevPreviewStatusDTO {
  return { holder: { kind: 'env', id: 'e' }, sandbox: 'attached', state, slot: { known: false }, openPath: '/o', canOpen: false, canStop: false, canResume: false, detectedAt: null };
}

describe('dev-preview copy', () => {
  it('labels every state, loud only where something is wrong', () => {
    expect(devPreviewBadge({ status: 'live', targetPort: 5173, via: 'relay', message: '' })).toEqual({ label: 'Live · :5173', tone: 'default' });
    expect(devPreviewBadge({ status: 'live', targetPort: 8080, via: 'direct', message: '' })).toEqual({ label: 'Live on :8080', tone: 'default' });
    expect(devPreviewBadge({ status: 'starting', targetPort: 3000, via: 'relay', message: '' }).tone).toBe('secondary');
    expect(devPreviewBadge({ status: 'down', targetPort: 3000, via: 'relay', error: null, message: '' }).tone).toBe('destructive');
    expect(devPreviewBadge({ status: 'blocked', targetPort: 3000, message: '' })).toEqual({ label: 'Port 8080 in use', tone: 'destructive' });
    expect(devPreviewBadge({ status: 'stopped', targetPort: 3000, stoppedAt: 'x', message: '' }).tone).toBe('outline');
    expect(devPreviewBadge({ status: 'stale', targetPort: 3000, message: '' }).label).toBe('Sandbox rebuilt');
    expect(devPreviewBadge({ status: 'instance-unknown', message: '' }).label).toBe('Unavailable');
    expect(devPreviewBadge({ status: 'none', message: '' }).label).toBe('No dev server');
  });

  it('offers an affordance line for every KNOWN dev server and none for "none"', () => {
    expect(devPreviewAffordanceText(preview({ status: 'live', targetPort: 5173, via: 'relay', message: '' }))).toBe('Dev server detected on :5173');
    expect(devPreviewAffordanceText(preview({ status: 'starting', targetPort: 5173, via: 'relay', message: '' }))).toBe('Dev server detected on :5173');
    expect(devPreviewAffordanceText(preview({ status: 'down', targetPort: 5173, via: 'relay', error: null, message: '' }))).toContain('not responding');
    expect(devPreviewAffordanceText(preview({ status: 'blocked', targetPort: 5173, message: '' }))).toContain('port 8080 is in use');
    expect(devPreviewAffordanceText(preview({ status: 'stopped', targetPort: 5173, stoppedAt: 'x', message: '' }))).toContain('switched off');
    expect(devPreviewAffordanceText(preview({ status: 'stale', targetPort: 5173, message: '' }))).toContain('started again');
    expect(devPreviewAffordanceText(preview({ status: 'instance-unknown', message: '' }))).toBe('Preview state unavailable');
    expect(devPreviewAffordanceText(preview({ status: 'none', message: '' }))).toBeNull();
    expect(shouldShowDevPreviewAffordance(undefined)).toBe(false);
    expect(shouldShowDevPreviewAffordance(preview({ status: 'none', message: '' }))).toBe(false);
    expect(shouldShowDevPreviewAffordance(preview({ status: 'live', targetPort: 1, via: 'relay', message: '' }))).toBe(true);
  });
});
