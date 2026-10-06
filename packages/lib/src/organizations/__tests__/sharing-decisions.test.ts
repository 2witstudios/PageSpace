import { describe, it, expect } from 'vitest';
import { DEFAULT_ORG_POLICIES } from '../policies-core';
import {
  ORG_POLICY_CODE,
  customDomainsDecision,
  decideGuestAdmission,
  pageGrantWidensAccess,
  publishingDecision,
  shareLinkCreationDecision,
  shareLinkUsable,
} from '../sharing-decisions';

const policies = (over: Partial<typeof DEFAULT_ORG_POLICIES>) => ({ ...DEFAULT_ORG_POLICIES, ...over });

describe('shareLinkCreationDecision', () => {
  it('POL-3 (partial) creation is allowed while public share links are on and refused, naming the policy, when off', () => {
    expect(shareLinkCreationDecision(policies({ publicShareLinks: true }))).toEqual({ ok: true });
    expect(shareLinkCreationDecision(policies({ publicShareLinks: false }))).toEqual({
      ok: false,
      code: ORG_POLICY_CODE,
      reason: ORG_POLICY_CODE,
      policy: 'publicShareLinks',
      status: 403,
      message: expect.stringContaining('share links'),
    });
  });
});

describe('shareLinkUsable', () => {
  it('POL-3 (partial) a link is usable only when its policy is on AND it is not suspended: either alone refuses', () => {
    expect(shareLinkUsable(policies({ publicShareLinks: true }), { suspendedByPolicy: null })).toBe(true);
    expect(shareLinkUsable(policies({ publicShareLinks: false }), { suspendedByPolicy: null })).toBe(false);
    expect(shareLinkUsable(policies({ publicShareLinks: true }), { suspendedByPolicy: 'publicShareLinks' })).toBe(false);
    expect(shareLinkUsable(policies({ publicShareLinks: false }), { suspendedByPolicy: 'publicShareLinks' })).toBe(false);
  });

  it('POL-3 (partial) a personal drive (no org policies) is never refused by this rule', () => {
    expect(shareLinkUsable(null, { suspendedByPolicy: null })).toBe(true);
    expect(shareLinkCreationDecision(null)).toEqual({ ok: true });
  });

  it('POL-3 (partial) a marker from any other rule still refuses: a link held by the org for any reason is not usable', () => {
    expect(shareLinkUsable(policies({}), { suspendedByPolicy: 'guests' })).toBe(false);
  });
});

describe('publishingDecision and customDomainsDecision', () => {
  it('POL-4 (partial) publishing and custom domains are separate switches, each refusing with its own policy', () => {
    expect(publishingDecision(policies({ publishWeb: false }))).toMatchObject({ ok: false, policy: 'publishWeb', status: 403 });
    expect(publishingDecision(policies({ publishWeb: true, customDomains: false }))).toEqual({ ok: true });
    expect(customDomainsDecision(policies({ customDomains: false }))).toMatchObject({ ok: false, policy: 'customDomains', status: 403 });
    expect(customDomainsDecision(policies({ customDomains: true, publishWeb: false }))).toEqual({ ok: true });
  });

  it('POL-4 (partial) a personal drive is never refused', () => {
    expect(publishingDecision(null)).toEqual({ ok: true });
    expect(customDomainsDecision(null)).toEqual({ ok: true });
  });
});

describe('decideGuestAdmission', () => {
  it.each([
    ['off', 'refused', { decision: 'refuse', refusal: 'guests_off' }],
    ['approve', 'held', { decision: 'hold' }],
    ['on', 'allowed', { decision: 'allow' }],
  ] as const)('POL-2 (partial) an outsider under guests=%s is %s', (guests, _label, expected) => {
    expect(decideGuestAdmission(policies({ guests }), { isOrgMember: false })).toEqual(expected);
  });

  it.each(['off', 'approve', 'on'] as const)('POL-2 (partial) an org member is never a guest, whatever the policy (%s)', (guests) => {
    expect(decideGuestAdmission(policies({ guests }), { isOrgMember: true })).toEqual({ decision: 'allow' });
  });

  it('POL-2 (partial) a personal drive has no guest policy: everyone is allowed', () => {
    expect(decideGuestAdmission(null, { isOrgMember: false })).toEqual({ decision: 'allow' });
  });
  // A lapsed org's outsider (D-OW-33) is refused by decideOrgDriveAdmission through checkOrgMayLoosen, not here:
  // lapsed-loosen.integration.test.ts proves it on real Postgres.
});

describe('pageGrantWidensAccess', () => {
  const flags = (over: Partial<{ canView: boolean; canEdit: boolean; canShare: boolean; canDelete: boolean }> = {}) => ({ canView: false, canEdit: false, canShare: false, canDelete: false, ...over });

  it('POL-2 (partial) a first grant that gives anything is an admission; a first grant of nothing is not', () => {
    expect(pageGrantWidensAccess(null, flags({ canView: true }))).toBe(true);
    expect(pageGrantWidensAccess(null, flags())).toBe(false);
  });

  it.each(['canView', 'canEdit', 'canShare', 'canDelete'] as const)('POL-2 (partial) turning %s on over an existing grant widens access', (flag) => {
    expect(pageGrantWidensAccess(flags({ canView: true }), flags({ canView: true, [flag]: true }))).toBe(flag !== 'canView');
    expect(pageGrantWidensAccess(flags(), flags({ [flag]: true }))).toBe(true);
  });

  it('POL-2 (partial) narrowing or repeating a grant never asks the policy: a guest can always be given LESS', () => {
    const full = flags({ canView: true, canEdit: true, canShare: true, canDelete: true });
    expect(pageGrantWidensAccess(full, flags({ canView: true }))).toBe(false);
    expect(pageGrantWidensAccess(full, full)).toBe(false);
    expect(pageGrantWidensAccess(full, flags())).toBe(false);
  });
});
