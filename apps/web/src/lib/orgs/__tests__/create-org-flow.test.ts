import { describe, it, expect } from 'vitest';
import { createOrgSeatCount, nextStepAfterCreate, orgReadyForSetup, parseInviteEmails, mergeInviteEmails } from '../create-org-flow';

describe('parseInviteEmails', () => {
  it('UI-6 (partial): splits on commas, spaces and new lines, lowercases and de-duplicates', () => {
    expect(parseInviteEmails('Priya@Northwind.com, dana@northwind.com\npriya@northwind.com  sam@x.io')).toEqual({
      valid: ['priya@northwind.com', 'dana@northwind.com', 'sam@x.io'],
      invalid: [],
    });
  });

  it('reports entries that are not email addresses', () => {
    expect(parseInviteEmails('ok@a.co, nope, @b.co')).toEqual({ valid: ['ok@a.co'], invalid: ['nope', '@b.co'] });
  });

  it('is empty for blank input', () => {
    expect(parseInviteEmails('  \n ,, ')).toEqual({ valid: [], invalid: [] });
  });
});

describe('mergeInviteEmails', () => {
  it('appends people from moved drives without repeating anyone already listed or the creator', () => {
    expect(mergeInviteEmails('a@x.io', ['A@x.io', 'b@x.io', 'me@x.io'], 'me@x.io')).toBe('a@x.io, b@x.io');
  });

  it('keeps the typed text when there is nothing new', () => {
    expect(mergeInviteEmails('a@x.io', ['a@x.io'], 'me@x.io')).toBe('a@x.io');
  });
});

describe('createOrgSeatCount', () => {
  it('UI-6 (partial): the creator plus each invited person is one seat each (SEAT-3)', () => {
    expect(createOrgSeatCount(['a@x.io', 'b@x.io'], 'me@x.io')).toBe(3);
  });

  it('never counts the creator twice', () => {
    expect(createOrgSeatCount(['ME@x.io', 'a@x.io'], 'me@x.io')).toBe(2);
    expect(createOrgSeatCount([], 'me@x.io')).toBe(1);
  });
});

describe('nextStepAfterCreate', () => {
  const sub = { status: 'incomplete', trialEnd: null, currentPeriodEnd: null, extraSeatQuantity: 0 };

  it('UI-6 (partial): payment_required goes to the Payment Element with the client secret (no trial, D-OW-30)', () => {
    expect(nextStepAfterCreate({ state: 'payment_required', subscription: sub, payment: { kind: 'confirm_payment', clientSecret: 'cs_1' } }))
      .toEqual({ step: 'payment', clientSecret: 'cs_1' });
  });

  it('a deployment without billing, or a subscription already paid, goes straight to setup', () => {
    expect(nextStepAfterCreate({ state: 'not_billed' })).toEqual({ step: 'setup' });
    expect(nextStepAfterCreate({ state: 'subscribed', subscription: { ...sub, status: 'active' } })).toEqual({ step: 'setup' });
  });

  it('an unreachable payment provider asks to retry the subscription', () => {
    expect(nextStepAfterCreate({ state: 'pending' })).toEqual({ step: 'retry_payment' });
  });
});

describe('orgReadyForSetup', () => {
  it('is ready once the org has no lapse notice (paid, or billing off)', () => {
    expect(orgReadyForSetup(undefined)).toBe(true);
    expect(orgReadyForSetup({ kind: 'payment_failed', canManageBilling: true })).toBe(true);
  });

  it('is not ready while the org is still lapsed (the webhook has not landed)', () => {
    expect(orgReadyForSetup({ kind: 'reactivate', reason: 'incomplete', canManageBilling: true })).toBe(false);
    expect(orgReadyForSetup({ kind: 'read_only', canManageBilling: false })).toBe(false);
  });
});
