import { describe, it, expect } from 'vitest';
import {
  spendChipModel,
  spendChoiceHint,
  spendChoiceAmount,
  composerStripModel,
  spendFallbackCopy,
  automationSpendCopy,
  type SurfaceChoice,
  type SurfaceDecision,
} from '../spend-surface';

const product: SurfaceChoice = {
  source: 'drive_wallet',
  walletId: 'w-product',
  label: 'Product wallet',
  driveName: 'Product',
  orgName: 'Northwind Labs',
  remainingCents: 192,
  remainingCredits: '192',
};
const seat: SurfaceChoice = {
  source: 'seat_allowance',
  walletId: 'w-pool',
  label: 'Northwind Labs seat',
  driveName: 'Product',
  orgName: 'Northwind Labs',
  remainingCents: 54,
  remainingCredits: '54',
};
const own: SurfaceChoice = {
  source: 'own_credits',
  walletId: 'w-me',
  label: 'Your credits',
  driveName: null,
  orgName: null,
  remainingCents: 1482,
  remainingCredits: '1,482',
};

const spends = (choice: SurfaceChoice, fallbackFrom: SurfaceChoice['source'] | null = null): SurfaceDecision => ({
  kind: 'spend',
  source: choice.source,
  walletId: choice.walletId,
  fallbackApplied: fallbackFrom !== null,
  fallbackFrom,
});


describe('spendChipModel: the header chip', () => {
  it('UI-8 (partial) the chip replaces the personal chip only where more than one source exists (SPEND-2 (partial), D20.8)', () => {
    expect(spendChipModel({ orgsEnabled: true, options: [own], resolved: spends(own) })).toBeNull();
    expect(spendChipModel({ orgsEnabled: true, options: [], resolved: spends(own) })).toBeNull();
    expect(spendChipModel({ orgsEnabled: true, options: [product, seat, own], resolved: spends(product) })).not.toBeNull();
  });

  it('UI-8 (partial) nothing shows while organizations are dark, whatever the options', () => {
    expect(spendChipModel({ orgsEnabled: false, options: [product, seat, own], resolved: spends(product) })).toBeNull();
  });

  it('UI-8 (partial) the chip is one short token: the source kind and a credit count, never the wallet name', () => {
    const chip = spendChipModel({ orgsEnabled: true, options: [product, seat, own], resolved: spends(product) });
    expect(chip).toEqual({ source: 'drive_wallet', text: '192 credits', tone: 'normal', ariaLabel: 'Spending from Product wallet: 192 credits' });
    expect(chip?.text).not.toContain('Product');
  });

  it('UI-8 (partial) the chip names what the gate will actually spend, so a fallback shows the new source (SPEND-4 (partial))', () => {
    const chip = spendChipModel({ orgsEnabled: true, options: [product, seat, own], resolved: spends(seat, 'drive_wallet') });
    expect(chip?.source).toBe('seat_allowance');
    expect(chip?.text).toBe('54 credits');
  });

  it('UI-8 (partial) a paused chosen wallet reads "Paused" and a refused source reads what is wrong', () => {
    const options = [product, seat, own];
    const refuse = (reason: string, source: SurfaceChoice['source'] | null = 'drive_wallet'): SurfaceDecision => ({ kind: 'refuse', source, reason, options: [] });
    expect(spendChipModel({ orgsEnabled: true, options, resolved: refuse('source_paused') })).toMatchObject({ source: 'drive_wallet', text: 'Paused', tone: 'paused' });
    expect(spendChipModel({ orgsEnabled: true, options, resolved: refuse('source_cap_reached') })).toMatchObject({ text: 'Cap reached', tone: 'refused' });
    expect(spendChipModel({ orgsEnabled: true, options, resolved: refuse('source_empty') })).toMatchObject({ text: '0 credits', tone: 'refused' });
    expect(spendChipModel({ orgsEnabled: true, options, resolved: refuse('no_source_chosen', null) })).toMatchObject({ source: null, text: 'Choose', tone: 'refused' });
    expect(spendChipModel({ orgsEnabled: true, options, resolved: refuse('chosen_wallet_unavailable', null) })).toMatchObject({ source: null, text: 'Choose', tone: 'refused' });
  });

  it('UI-8 (partial) a source with no limit of its own shows no number rather than a sentinel', () => {
    const unlimited = { ...product, remainingCents: null, remainingCredits: null };
    expect(spendChipModel({ orgsEnabled: true, options: [unlimited, own], resolved: spends(unlimited) })?.text).toBe('No cap');
  });
});

describe('spendChoiceHint and spendChoiceAmount: the popover rows', () => {
  it('UI-8 (partial) each source says who funds it, by name, never by id', () => {
    expect(spendChoiceHint(product)).toBe('Funded by Northwind Labs');
    expect(spendChoiceHint({ ...product, orgName: null })).toBe("Funded by the drive's owner");
    expect(spendChoiceHint(seat)).toBe('Your seat allowance from Northwind Labs');
    expect(spendChoiceHint(own)).toBe('Personal balance · not billed to an organization');
  });

  it('SPEND-9 (partial) amounts are the person\'s own remaining credits, with no currency symbol', () => {
    expect(spendChoiceAmount(product)).toBe('192 credits left');
    expect(spendChoiceAmount(seat)).toBe('54 credits left');
    expect(spendChoiceAmount(own)).toBe('1,482 credits');
    expect(spendChoiceAmount({ ...product, remainingCredits: null, remainingCents: null })).toBe('No cap');
    for (const c of [product, seat, own]) expect(spendChoiceAmount(c)).not.toContain('$');
  });
});

describe('composerStripModel: the strip before the first message', () => {
  it('SPEND-2 (partial) the source is named before the first message, and only then', () => {
    expect(composerStripModel({ orgsEnabled: true, options: [product, seat, own], resolved: spends(product), hasMessages: false }))
      .toEqual({ label: 'Product wallet', detail: '192 credits left', tone: 'normal' });
    expect(composerStripModel({ orgsEnabled: true, options: [product, seat, own], resolved: spends(product), hasMessages: true })).toBeNull();
  });

  it('SPEND-2 (partial) no strip with a single source or while organizations are dark', () => {
    expect(composerStripModel({ orgsEnabled: true, options: [own], resolved: spends(own), hasMessages: false })).toBeNull();
    expect(composerStripModel({ orgsEnabled: false, options: [product, own], resolved: spends(product), hasMessages: false })).toBeNull();
  });

  it('SPEND-4 (partial) a fallback the drive rule applies is named on the strip before sending', () => {
    expect(composerStripModel({ orgsEnabled: true, options: [product, seat, own], resolved: spends(seat, 'drive_wallet'), hasMessages: false }))
      .toEqual({ label: 'Northwind Labs seat', detail: '54 credits left · Product wallet cannot cover this', tone: 'fallback' });
  });

  it('SPEND-4 (partial) a refused source the person knows is named with what is wrong, so they know to choose another', () => {
    const refuse = (reason: string): SurfaceDecision => ({ kind: 'refuse', source: 'drive_wallet', reason, options: [] });
    expect(composerStripModel({ orgsEnabled: true, options: [product, seat, own], resolved: refuse('source_cap_reached'), hasMessages: false }))
      .toEqual({ label: 'Product wallet', detail: 'you reached your cap here · choose another source', tone: 'refused' });
    expect(composerStripModel({ orgsEnabled: true, options: [product, own], resolved: refuse('source_paused'), hasMessages: false })?.detail)
      .toBe('paused · choose another source');
    expect(composerStripModel({ orgsEnabled: true, options: [product, own], resolved: refuse('source_empty'), hasMessages: false })?.detail)
      .toBe('empty this month · choose another source');
  });

  it('SPEND-4 (partial) a refused source asks for a choice instead of naming a source', () => {
    const refused: SurfaceDecision = { kind: 'refuse', source: null, reason: 'no_source_chosen', options: [] };
    expect(composerStripModel({ orgsEnabled: true, options: [product, own], resolved: refused, hasMessages: false }))
      .toEqual({ label: null, detail: 'Choose what this conversation spends from', tone: 'refused' });
  });
});

describe('spendFallbackCopy: the fallback notice', () => {
  it('SPEND-4 (partial) a fallback names the source used and the one it moved off, and why when known', () => {
    expect(spendFallbackCopy({ from: 'drive_wallet', to: 'seat_allowance', fromLabel: 'Product wallet', fromStatus: 'over' }))
      .toBe('Used your seat allowance because Product wallet was empty.');
    expect(spendFallbackCopy({ from: 'drive_wallet', to: 'own_credits', fromLabel: 'Product wallet', fromStatus: 'paused' }))
      .toBe('Used your own credits because Product wallet is paused.');
    expect(spendFallbackCopy({ from: 'drive_wallet', to: 'own_credits', fromLabel: null, fromStatus: null }))
      .toBe("Used your own credits because the drive wallet couldn't cover this.");
  });

  it('SPEND-4 (partial) a notice that moved nowhere, or a malformed one, says nothing', () => {
    expect(spendFallbackCopy({ from: 'own_credits', to: 'own_credits', fromLabel: null, fromStatus: null })).toBeNull();
    expect(spendFallbackCopy({ from: 'nope', to: 'own_credits', fromLabel: null, fromStatus: null })).toBeNull();
  });
});

describe('automationSpendCopy: who an automation spends as', () => {
  it('SPEND-6 (partial) a scheduled run spends as its creator, under their caps; a mention or manual Run as whoever triggered it (D-OW-34)', () => {
    expect(automationSpendCopy({ creatorName: 'Priya Nair', walletLabel: 'Product wallet' })).toEqual({
      badge: 'As Priya',
      line: 'Created by Priya Nair',
      detail: "Each scheduled run spends only Product wallet, as Priya Nair under their caps, and never falls back to anyone's own credits. A channel mention or a manual Run counts against whoever triggered it. If the wallet can't pay, the run is skipped and logged.",
    });
  });

  it('SPEND-6 (partial) the copy never promises an automation a fallback it does not get (orchestrator ruling on UI-8)', () => {
    for (const input of [{ creatorName: 'Priya Nair', walletLabel: 'Product wallet' }, { creatorName: null, walletLabel: null }]) {
      expect(automationSpendCopy(input).detail).not.toMatch(/fallback apply|caps and fallback|no source can pay/);
    }
  });

  it('SPEND-6 (partial) an unknown creator or wallet still reads as a sentence', () => {
    expect(automationSpendCopy({ creatorName: null, walletLabel: null }).detail).toBe(
      "Each scheduled run spends only the drive's wallet once it has one, as its creator under their caps. A channel mention or a manual Run counts against whoever triggered it. If the wallet can't pay, the run is skipped and logged.",
    );
    expect(automationSpendCopy({ creatorName: null, walletLabel: null }).badge).toBe('As its creator');
  });
});
