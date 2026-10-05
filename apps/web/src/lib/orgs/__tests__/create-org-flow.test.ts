import { describe, it, expect } from 'vitest';
import { createOrgSeatCount, nextStepAfterCreate, orgReadyForSetup, parseInviteEmails, mergeInviteEmails, planOrgSetup, createOrgPlanNote, firstPaymentLines } from '../create-org-flow';
import { orgPlanQuote } from '@pagespace/lib/billing/org-plan-quote';

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

describe('planOrgSetup', () => {
  it('UI-6 (partial): moves the chosen drives, then sends each invitation', () => {
    expect(planOrgSetup({ driveIds: ['d1', 'd2'], invites: ['a@x.io'], selfEmail: 'me@x.io', includedSeats: 5 })).toEqual([
      { kind: 'move_drive', driveId: 'd1' },
      { kind: 'move_drive', driveId: 'd2' },
      { kind: 'invite', email: 'a@x.io' },
    ]);
  });

  it('SEAT-4 (partial): turns on automatic seats before inviting past the included seats (a new org starts with it off)', () => {
    const invites = ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io', 'e@x.io'];
    const plan = planOrgSetup({ driveIds: [], invites, selfEmail: 'me@x.io', includedSeats: 5 });
    expect(plan[0]).toEqual({ kind: 'enable_auto_seats' });
    expect(plan.slice(1).map((t) => t.kind)).toEqual(['invite', 'invite', 'invite', 'invite', 'invite']);
  });

  it('leaves automatic seats alone when everyone fits in the included seats', () => {
    const plan = planOrgSetup({ driveIds: [], invites: ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io'], selfEmail: 'me@x.io', includedSeats: 5 });
    expect(plan.some((t) => t.kind === 'enable_auto_seats')).toBe(false);
  });

  it('never invites the creator', () => {
    expect(planOrgSetup({ driveIds: [], invites: ['ME@x.io'], selfEmail: 'me@x.io', includedSeats: 5 })).toEqual([]);
  });
});

describe('createOrgPlanNote', () => {
  it('UI-6 (partial) UI-12 (partial): price in dollars, credits as a plain count, no trial', () => {
    const note = createOrgPlanNote(orgPlanQuote(13, true));
    expect(note.headline).toBe('Business · $50 a month with 5 seats, $10 per extra seat.');
    expect(note.body).toContain('You and 12 people make 13 seats: $130 a month with 7,800 credits a month.');
    expect(note.body).toContain('ready once that first payment goes through');
    expect(note.body).not.toMatch(/trial/i);
    expect(note.body).not.toMatch(/\$7,800|\$78/);
  });

  it('explains that extra seats are billed as people are invited, since the first payment covers the included seats', () => {
    expect(createOrgPlanNote(orgPlanQuote(13, true)).body).toContain('The first payment is $50. The 8 extra seats are added as you invite people, billed pro rata.');
    expect(createOrgPlanNote(orgPlanQuote(3, true)).body).not.toContain('extra seats are added');
  });

  it('speaks to one person alone', () => {
    expect(createOrgPlanNote(orgPlanQuote(1, true)).body).toContain('Just you is 1 seat: $50 a month with 3,000 credits a month.');
  });
});

describe('firstPaymentLines', () => {
  it('UI-6 (partial): itemises what the first invoice charges, from the subscription the route created', () => {
    expect(firstPaymentLines(0)).toEqual({ lines: [{ label: 'Business · 5 seats included', amount: '$50.00' }], total: '$50.00' });
    expect(firstPaymentLines(8)).toEqual({
      lines: [{ label: 'Business · 5 seats included', amount: '$50.00' }, { label: '8 extra seats × $10', amount: '$80.00' }],
      total: '$130.00',
    });
  });
});
