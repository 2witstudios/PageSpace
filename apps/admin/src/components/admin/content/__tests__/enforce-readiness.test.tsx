import { describe, expect, it } from 'vitest';
import { readinessHeadline, type ReadinessItemView } from '../enforce-readiness';

const item = (status: ReadinessItemView['status']): ReadinessItemView => ({ id: status, label: status, status, detail: '' });

describe('readinessHeadline', () => {
  it('counts what blocks, says when nothing does, and recognises enforce', () => {
    expect(readinessHeadline({ ready: false, mode: 'shadow', items: [item('blocking'), item('blocking'), item('ok')] })).toBe('2 checks still block enforce mode.');
    expect(readinessHeadline({ ready: false, mode: 'shadow', items: [item('blocking')] })).toBe('1 check still blocks enforce mode.');
    expect(readinessHeadline({ ready: true, mode: 'shadow', items: [item('manual')] })).toContain('Confirm the manual items');
    expect(readinessHeadline({ ready: true, mode: 'enforce', items: [] })).toBe('Enforce mode is on.');
  });
});
