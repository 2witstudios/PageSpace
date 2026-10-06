import { describe, it, expect } from 'vitest';
import { inviteeStanding, guestChoice, seatChoice } from '../invite-choice';

const members = [{ userId: 'u-priya', email: 'Priya@Northwind.com' }];

describe('invite-choice: inviting someone to an org drive', () => {
  it('UI-5 (partial) a person already in the org is a plain invite; anyone else is an outsider (by account or by email, case-insensitive)', () => {
    expect(inviteeStanding({ userId: 'u-priya' }, members)).toBe('in_org');
    expect(inviteeStanding({ email: ' priya@northwind.com ' }, members)).toBe('in_org');
    expect(inviteeStanding({ userId: 'u-chris', email: 'chris@partner.co' }, members)).toBe('outsider');
    expect(inviteeStanding({}, members)).toBe('outsider');
  });

  it('UI-5 (partial) POL-2 (partial) the guest choice follows the Guests policy: on adds, approve needs an org admin, off is unavailable', () => {
    expect(guestChoice({ driveName: 'Product', orgName: 'Northwind Labs', guestPolicy: 'on' })).toEqual({ enabled: true, needsApproval: false, hint: 'No seat. Only sees Product.' });
    expect(guestChoice({ driveName: 'Product', orgName: 'Northwind Labs', guestPolicy: 'approve' })).toEqual({ enabled: true, needsApproval: true, hint: 'No seat. Only sees Product. Needs approval from a Northwind Labs admin under the Guests policy.' });
    expect(guestChoice({ driveName: 'Product', orgName: 'Northwind Labs', guestPolicy: 'off' })).toEqual({ enabled: false, needsApproval: false, hint: 'Guests are turned off for Northwind Labs.' });
    expect(guestChoice({ driveName: 'Product', orgName: 'Northwind Labs', guestPolicy: null }).hint).toBe('No seat. Only sees Product. Depends on the Northwind Labs Guests policy: an admin may need to approve it, or guests may be turned off.');
  });

  it('UI-5 (partial) SEAT-3 (partial) the member choice uses a seat and needs an email to invite to the org', () => {
    expect(seatChoice({ orgName: 'Northwind Labs', hasEmail: true })).toEqual({ enabled: true, hint: 'Uses a seat in Northwind Labs. Can open every Open drive and be added to any other.' });
    expect(seatChoice({ orgName: 'Northwind Labs', hasEmail: false })).toEqual({ enabled: false, hint: 'Invite them by email to give them a seat in Northwind Labs.' });
  });
});
