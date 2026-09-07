import { describe, it, expect } from 'vitest';
import { devPreviewAffordanceText, devPreviewAffordanceVerb, devPreviewApprovalAudience, devPreviewBadge, shouldShowDevPreviewAffordance } from '../dev-preview-copy';
import type { DevPreviewStatusDTO } from '@/hooks/dev-preview/useDevPreviewStatus';

function preview(state: DevPreviewStatusDTO['state']): DevPreviewStatusDTO {
  return { holder: { kind: 'env', id: 'e' }, canManage: false, sandbox: 'attached', detection: 'watching', state, slot: { known: false }, openPath: '/o', canOpen: false, canStop: false, canResume: false, canApprove: false, detectedAt: null };
}

describe('dev-preview copy', () => {
  it('labels every state, loud only where something is wrong', () => {
    expect(devPreviewBadge({ status: 'live', targetPort: 5173, via: 'relay', message: '' })).toEqual({ label: 'Live · :5173', tone: 'default' });
    expect(devPreviewBadge({ status: 'live', targetPort: 8080, via: 'direct', message: '' })).toEqual({ label: 'Live on :8080', tone: 'default' });
    expect(devPreviewBadge({ status: 'starting', targetPort: 3000, via: 'relay', message: '' }).tone).toBe('secondary');
    expect(devPreviewBadge({ status: 'down', targetPort: 3000, via: 'relay', error: null, repairable: true, message: '' }).tone).toBe('destructive');
    expect(devPreviewBadge({ status: 'blocked', targetPort: 3000, message: '' })).toEqual({ label: 'Port 8080 in use', tone: 'destructive' });
    expect(devPreviewBadge({ status: 'stopped', targetPort: 3000, stoppedAt: 'x', message: '' }).tone).toBe('outline');
    expect(devPreviewBadge({ status: 'stale', targetPort: 3000, message: '' }).label).toBe('Sandbox rebuilt');
    expect(devPreviewBadge({ status: 'instance-unknown', message: '' }).label).toBe('Unavailable');
    expect(devPreviewBadge({ status: 'none', message: '' }).label).toBe('No dev server');
  });

  it('offers an affordance line for every KNOWN dev server and none for "none"', () => {
    expect(devPreviewAffordanceText(preview({ status: 'live', targetPort: 5173, via: 'relay', message: '' }))).toBe('Dev server detected on :5173');
    expect(devPreviewAffordanceText(preview({ status: 'starting', targetPort: 5173, via: 'relay', message: '' }))).toBe('Dev server detected on :5173');
    // Not "the dev server is not responding": a `down` preview is as often a
    // relay that was never created, and the server itself may be fine.
    expect(devPreviewAffordanceText(preview({ status: 'down', targetPort: 5173, via: 'relay', error: null, repairable: true, message: '' }))).toBe('Preview of :5173 is not running');
    expect(devPreviewAffordanceText(preview({ status: 'blocked', targetPort: 5173, message: '' }))).toContain('port 8080 is in use');
    expect(devPreviewAffordanceText(preview({ status: 'stopped', targetPort: 5173, stoppedAt: 'x', message: '' }))).toContain('switched off');
    expect(devPreviewAffordanceText(preview({ status: 'stale', targetPort: 5173, message: '' }))).toContain('started again');
    expect(devPreviewAffordanceText(preview({ status: 'instance-unknown', message: '' }))).toBe('Preview state unavailable');
    expect(devPreviewAffordanceText(preview({ status: 'none', message: '' }))).toBeNull();
    expect(shouldShowDevPreviewAffordance(undefined)).toBe(false);
    expect(shouldShowDevPreviewAffordance(preview({ status: 'none', message: '' }))).toBe(false);
    expect(shouldShowDevPreviewAffordance(preview({ status: 'live', targetPort: 1, via: 'relay', message: '' }))).toBe(true);
  });

  it('a status this build does not know falls back to neutral copy instead of throwing or rendering an empty label', () => {
    const bogus = { status: 'teleporting', message: 'from the future' } as unknown as DevPreviewStatusDTO['state'];
    expect(devPreviewBadge(bogus)).toEqual({ label: 'Unknown state', tone: 'outline' });
    expect(devPreviewAffordanceText(preview(bogus))).toBe('Preview state unknown');
    expect(shouldShowDevPreviewAffordance(preview(bogus))).toBe(true);
    // ...and it never earns the live verb: canOpen is the server's, and a bogus state has none.
    expect(devPreviewAffordanceVerb(preview(bogus))).toBe('Details');
  });

  it('the verb promises a live app only when the frame would show one', () => {
    expect(devPreviewAffordanceVerb({ ...preview({ status: 'live', targetPort: 1, via: 'relay', message: '' }), canOpen: true })).toBe('Preview');
    expect(devPreviewAffordanceVerb(preview({ status: 'down', targetPort: 1, via: 'relay', error: null, repairable: true, message: '' }))).toBe('Details');
    expect(devPreviewAffordanceVerb(preview({ status: 'blocked', targetPort: 1, message: '' }))).toBe('Details');
    expect(devPreviewAffordanceVerb(preview({ status: 'stale', targetPort: 1, message: '' }))).toBe('Details');
  });
});

describe('needs-approval copy', () => {
  it('names the port in the badge and the line, and never claims the preview is live', () => {
    const state = { status: 'needs-approval' as const, targetPort: 9000, message: 'not shared yet' };
    expect(devPreviewBadge(state)).toEqual({ label: 'Needs your OK · :9000', tone: 'secondary' });
    expect(devPreviewAffordanceText(preview(state))).toBe('Dev server detected on :9000 — not shared yet');
  });

  it('states the audience per holder kind — the sentence that makes "share" mean something', () => {
    expect(devPreviewApprovalAudience({ kind: 'env', id: 'e' })).toContain('drive');
    expect(devPreviewApprovalAudience({ kind: 'workspace', id: 'w' })).toContain('session');
  });
});
