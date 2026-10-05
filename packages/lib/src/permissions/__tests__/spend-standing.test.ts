import { describe, it, expect } from 'vitest';
import { automationCreatorRemains, sharedSpendLegsFor, type DriveSpendStanding } from '../spend-standing';

// Northwind Labs fixture: Product is an Open org drive, Customer Research a Restricted one.
const standing = (over: Partial<DriveSpendStanding> = {}): DriveSpendStanding => ({
  driveId: 'd-product',
  orgId: 'o-northwind',
  ownerId: 'u-jono',
  isLead: false,
  isDriveMember: true,
  isOrgMember: true,
  ...over,
});

describe('spend-standing: which shared legs a person may draw at all', () => {
  it('SPEND-1 (partial) an effective member of an org drive who holds a seat may draw the drive wallet and their seat', () => {
    expect(sharedSpendLegsFor(standing())).toEqual({ driveWallet: true, seat: true });
  });

  it('SPEND-1 (partial) an ORG MEMBER with no membership of a Restricted org drive draws neither the drive wallet nor a seat there', () => {
    // Priya before her join request is approved: in the org, not in Customer Research.
    expect(sharedSpendLegsFor(standing({ driveId: 'd-research', isDriveMember: false, isOrgMember: true }))).toEqual({ driveWallet: false, seat: false });
  });

  it('DRV-8 (partial) a guest may draw the drive wallet leg (the drive rule then decides) but never a seat', () => {
    expect(sharedSpendLegsFor(standing({ isOrgMember: false }))).toEqual({ driveWallet: true, seat: false });
  });

  it('a personal drive has no seat; its member may draw its wallet, a non-member nothing', () => {
    expect(sharedSpendLegsFor(standing({ orgId: null, isOrgMember: false }))).toEqual({ driveWallet: true, seat: false });
    expect(sharedSpendLegsFor(standing({ orgId: null, isOrgMember: false, isDriveMember: false }))).toEqual({ driveWallet: false, seat: false });
  });

  it('a drive that does not exist opens nothing', () => {
    expect(sharedSpendLegsFor(null)).toEqual({ driveWallet: false, seat: false });
  });
});

describe('spend-standing: whether an automation\'s creator still stands behind it', () => {
  it('SPEND-6 (partial) on an org drive the creator must still be an accepted member of the org; one who left is departed', () => {
    expect(automationCreatorRemains(standing())).toBe(true);
    expect(automationCreatorRemains(standing({ isOrgMember: false, isDriveMember: false }))).toBe(false);
    // A departed member keeps nothing through the drive either: org membership is the test on an org drive.
    expect(automationCreatorRemains(standing({ isOrgMember: false, isDriveMember: true }))).toBe(false);
  });

  it('SPEND-6 (partial) on a personal drive the creator must still be a member of the drive', () => {
    expect(automationCreatorRemains(standing({ orgId: null, isOrgMember: false, isDriveMember: true }))).toBe(true);
    expect(automationCreatorRemains(standing({ orgId: null, isOrgMember: false, isDriveMember: false }))).toBe(false);
  });

  it('SPEND-6 (partial) a drive that does not exist has no creator standing behind any automation (fail closed)', () => {
    expect(automationCreatorRemains(null)).toBe(false);
  });
});
