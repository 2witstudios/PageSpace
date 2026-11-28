import { describe, it, expect } from 'vitest';
import type { UserId } from '../grant';
import { autoApproveOf, decideAccountEdit } from '../decide-account-edit';

const NOW = 1_800_000_000_000;
const EDITOR = 'editor' as UserId;
const OWNER = 'owner' as UserId;
const edit = (overrides: Partial<Parameters<typeof decideAccountEdit>[0]['edit']> = {}) => ({ allowedOrigins: ['https://api.example.com'], autoApprove: { enabled: false } as const, ...overrides });
const decide = (overrides: Partial<Parameters<typeof decideAccountEdit>[0]> = {}) => decideAccountEdit({ edit: edit(), editor: EDITOR, storedApprover: null, keepApprover: false, providerSlug: null, now: NOW, ...overrides });

describe('decideAccountEdit', () => {
  it('given sites in any form, should pin each canonical origin once, sorted, and ask for every request when auto-approve is off', () => {
    const actual = decide({ edit: edit({ allowedOrigins: ['https://B.example.com', 'https://a.example.com', 'https://a.example.com:443'] }) });
    expect(actual).toEqual({ ok: true, allowedOrigins: ['https://a.example.com:443', 'https://b.example.com:443'], approvalPolicy: null });
  });

  it('given no sites, too many sites, or a site that is not https, should refuse', () => {
    const actual = [
      decide({ edit: edit({ allowedOrigins: [] }) }),
      decide({ edit: edit({ allowedOrigins: Array.from({ length: 21 }, (_, index) => `https://s${index}.example.com`) }) }),
      decide({ edit: edit({ allowedOrigins: ['http://plain.example.com'] }) }).ok,
    ];
    expect(actual).toEqual([{ ok: false, reason: 'origins_empty' }, { ok: false, reason: 'origins_too_many' }, false]);
  });

  it('given auto-approve on, should write a policy over exactly the pinned sites that still asks for irreversible operations', () => {
    const actual = decide({ edit: edit({ autoApprove: { enabled: true, maxUsesPerHour: 25, until: null } }) });
    expect(actual).toEqual({
      ok: true,
      allowedOrigins: ['https://api.example.com:443'],
      approvalPolicy: {
        scope: { origins: ['https://api.example.com:443'], operations: [{ class: 'unknown', name: 'generic_request' }], resources: [] },
        trigger: 'irreversible_only',
        duration: null,
        limits: { maxUsesPerHour: 25, maxBytesOut: 10 * 1024 * 1024, maxConcurrent: 4 },
        approver: EDITOR,
      },
    });
  });

  it('given a cap outside 1–1000 or not whole, or an end date in the past or minutes away, should refuse', () => {
    const on = (maxUsesPerHour: number, until: number | null) => decide({ edit: edit({ autoApprove: { enabled: true, maxUsesPerHour, until } }) });
    const actual = [on(0, null), on(1_001, null), on(2.5, null), on(10, NOW - 1), on(10, NOW + 60_000)];
    expect(actual).toEqual([
      { ok: false, reason: 'limit_invalid' },
      { ok: false, reason: 'limit_invalid' },
      { ok: false, reason: 'limit_invalid' },
      { ok: false, reason: 'until_invalid' },
      { ok: false, reason: 'until_invalid' },
    ]);
  });

  it('given keepApprover, should keep the stored approver; otherwise record the editor', () => {
    const on = edit({ autoApprove: { enabled: true, maxUsesPerHour: 10, until: NOW + 86_400_000 } });
    const approverOf = (verdict: ReturnType<typeof decideAccountEdit>) => (verdict.ok ? verdict.approvalPolicy?.approver : null);
    const actual = [approverOf(decide({ edit: on, storedApprover: OWNER, keepApprover: true })), approverOf(decide({ edit: on, storedApprover: OWNER, keepApprover: false }))];
    expect(actual).toEqual([OWNER, EDITOR]);
  });
});

describe('decideAccountEdit — provider accounts', () => {
  it('given a Google account, should cover the ticked classes (read by default) and ask for unregistered requests', () => {
    const on = (classes?: readonly ('read' | 'write')[]) => decide({ providerSlug: 'google', edit: edit({ autoApprove: { enabled: true, maxUsesPerHour: 10, until: null, ...(classes ? { classes } : {}) } }) });
    const policyOf = (verdict: ReturnType<typeof decideAccountEdit>) => (verdict.ok ? [verdict.approvalPolicy?.scope.operations, verdict.approvalPolicy?.trigger] : verdict.reason);
    expect([policyOf(on()), policyOf(on(['write', 'read'])), policyOf(on([]))]).toEqual([
      [[{ class: 'read', name: '*' }], 'unknown_and_irreversible'],
      [[{ class: 'read', name: '*' }, { class: 'write', name: '*' }], 'unknown_and_irreversible'],
      'classes_invalid',
    ]);
  });
});

describe('autoApproveOf', () => {
  it('given a stored policy, should read its cap and end; given none or a malformed one, should report every request asks', () => {
    const actual = [
      autoApproveOf({ limits: { maxUsesPerHour: 60 }, duration: null }),
      autoApproveOf({ limits: { maxUsesPerHour: 5 }, duration: { until: NOW } }),
      autoApproveOf(null),
      autoApproveOf({ limits: { maxUsesPerHour: 'lots' } }),
    ];
    expect(actual).toEqual([{ enabled: true, maxUsesPerHour: 60, until: null, classes: [] }, { enabled: true, maxUsesPerHour: 5, until: NOW, classes: [] }, null, null]);
  });
});
