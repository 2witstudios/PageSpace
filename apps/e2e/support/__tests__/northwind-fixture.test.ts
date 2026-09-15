/**
 * Data-shape checks for the Northwind Labs fixture (Sequence Spec Part 2). No database: the
 * constants are the contract later lanes consume, so a drift in a name or a number is caught
 * here before a spec goes looking for "Customer Research" and finds nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  NORTHWIND_AGENTS,
  NORTHWIND_DRIVES,
  NORTHWIND_ORG,
  NORTHWIND_PEOPLE,
  NORTHWIND_WORKFLOWS,
} from '../../fixtures/northwind';

describe('Northwind Labs fixture (Sequence Spec Part 2)', () => {
  it('names the org northwind with 15 seats and a 9,000-credit pool as integer counts', () => {
    expect(NORTHWIND_ORG).toEqual({ name: 'Northwind Labs', slug: 'northwind', seats: 15, poolCredits: 9000 });
    expect(Number.isInteger(NORTHWIND_ORG.poolCredits)).toBe(true);
  });

  it('has the eight named people with one owner, two admins, three members, two guests', () => {
    expect(NORTHWIND_PEOPLE.map((p) => p.name)).toEqual([
      'Jono',
      'Priya Nair',
      'Dana Kim',
      'Marcus Oyelaran',
      'Lena Schulz',
      'Tomás Alvarez',
      'Chris Rowe',
      'Aisha Bello',
    ]);
    const byRole = (role: string) => NORTHWIND_PEOPLE.filter((p) => p.role === role).length;
    expect([byRole('owner'), byRole('admin'), byRole('member'), byRole('guest')]).toEqual([1, 2, 3, 2]);
  });

  it('X-6 every guest resolves exactly one drive and no non-guest carries a guest drive', () => {
    for (const person of NORTHWIND_PEOPLE) {
      if (person.role === 'guest') {
        expect(person.guestOf, `${person.name} must be a guest of one drive`).toBeDefined();
        expect(NORTHWIND_DRIVES.some((d) => d.key === person.guestOf)).toBe(true);
      } else {
        expect(person.guestOf).toBeUndefined();
      }
    }
  });

  it('has the six drives with the visibilities the Sequence Spec records', () => {
    expect(NORTHWIND_DRIVES.map((d) => [d.name, d.visibility])).toEqual([
      ['Product', 'open'],
      ['Design System', 'open'],
      ['Marketing Site', 'open'],
      ['Customer Research', 'restricted'],
      ['Engineering', 'open'],
      ['Finance', 'private'],
    ]);
  });

  it('allocates wallets Product 1,200, Engineering 900 (over), Customer Research 600, within the pool', () => {
    const wallets = Object.fromEntries(NORTHWIND_DRIVES.filter((d) => d.wallet).map((d) => [d.key, d.wallet]));
    expect(wallets).toEqual({
      product: { credits: 1200, over: false },
      engineering: { credits: 900, over: true },
      customerResearch: { credits: 600, over: false },
    });
    const allocated = NORTHWIND_DRIVES.reduce((sum, d) => sum + (d.wallet?.credits ?? 0), 0);
    expect(allocated).toBe(2700);
    expect(allocated).toBeLessThanOrEqual(NORTHWIND_ORG.poolCredits);
    for (const d of NORTHWIND_DRIVES) if (d.wallet) expect(Number.isInteger(d.wallet.credits)).toBe(true);
  });

  it('places the Research agent and the weekly digest workflow in Product', () => {
    expect(NORTHWIND_AGENTS).toEqual([{ name: 'Research', drive: 'product' }]);
    expect(NORTHWIND_WORKFLOWS).toEqual([{ name: 'Weekly digest', drive: 'product', cadence: 'weekly' }]);
    expect(NORTHWIND_DRIVES.find((d) => d.key === 'product')?.wallet).not.toBeNull();
  });
});
