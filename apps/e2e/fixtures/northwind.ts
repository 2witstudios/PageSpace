/**
 * Northwind Labs — the story-continuity fixture for the Organizations & Wallets epic
 * (Sequence Spec jbrbal9gsls1365psowacrur, Part 2). The same cast and numbers run through
 * every wave so states are recognisable; later lanes EXTEND this file rather than inventing
 * names.
 *
 * Wave A (lane A4): the org, wallet, seat, and visibility tables do not exist yet, so only
 * the people and the six drives are seeded as rows. Everything an org lane will need — org
 * slug, roles, drive visibility, wallet allocations, the seat count and the pool — is recorded
 * here as data constants for the lanes that build those tables (B1 org schema, B4 membership,
 * C1 wallets schema) to consume, and `seedNorthwind` returns the row ids so a spec can address
 * the seeded rows by fixture key.
 */
import { factories } from '@pagespace/db/test/factories';

export type NorthwindRole = 'owner' | 'admin' | 'member' | 'guest';
export type DriveVisibility = 'open' | 'restricted' | 'private';

export interface NorthwindPerson {
  /** Stable key used by specs and by `seedNorthwind`'s return value. */
  key: 'jono' | 'priya' | 'dana' | 'marcus' | 'lena' | 'tomas' | 'chris' | 'aisha';
  name: string;
  role: NorthwindRole;
  /**
   * Guests resolve exactly ONE drive (X-6: "a guest cannot see a second drive"). The Sequence
   * Spec names the guests but not their drive, so the assignment is a fixture choice.
   */
  guestOf?: NorthwindDriveKey;
}

export type NorthwindDriveKey =
  | 'product'
  | 'designSystem'
  | 'marketingSite'
  | 'customerResearch'
  | 'engineering'
  | 'finance';

export interface NorthwindWallet {
  /** Credits allocated to the drive wallet from the org pool (integer credit count, MON-5). */
  credits: number;
  /**
   * `true` when the Sequence Spec marks the wallet "(over)": it has spent past its allocation
   * and sits in debt at the moment the story opens.
   */
  over: boolean;
}

export interface NorthwindDrive {
  key: NorthwindDriveKey;
  name: string;
  visibility: DriveVisibility;
  /** Null when the drive draws on the org pool with no allocation of its own. */
  wallet: NorthwindWallet | null;
}

export const NORTHWIND_ORG = {
  name: 'Northwind Labs',
  slug: 'northwind',
  /** Business tier: 5 included seats plus 10 extra (Sequence Spec, after Wave C). */
  seats: 15,
  /** Org pool, integer credits. */
  poolCredits: 9_000,
} as const;

export const NORTHWIND_PEOPLE: readonly NorthwindPerson[] = [
  { key: 'jono', name: 'Jono', role: 'owner' },
  { key: 'priya', name: 'Priya Nair', role: 'admin' },
  { key: 'dana', name: 'Dana Kim', role: 'admin' },
  { key: 'marcus', name: 'Marcus Oyelaran', role: 'member' },
  { key: 'lena', name: 'Lena Schulz', role: 'member' },
  { key: 'tomas', name: 'Tomás Alvarez', role: 'member' },
  { key: 'chris', name: 'Chris Rowe', role: 'guest', guestOf: 'marketingSite' },
  { key: 'aisha', name: 'Aisha Bello', role: 'guest', guestOf: 'product' },
];

export const NORTHWIND_DRIVES: readonly NorthwindDrive[] = [
  { key: 'product', name: 'Product', visibility: 'open', wallet: { credits: 1_200, over: false } },
  { key: 'designSystem', name: 'Design System', visibility: 'open', wallet: null },
  { key: 'marketingSite', name: 'Marketing Site', visibility: 'open', wallet: null },
  { key: 'customerResearch', name: 'Customer Research', visibility: 'restricted', wallet: { credits: 600, over: false } },
  { key: 'engineering', name: 'Engineering', visibility: 'open', wallet: { credits: 900, over: true } },
  { key: 'finance', name: 'Finance', visibility: 'private', wallet: null },
];

/** The Research agent lives in Product; the weekly digest runs on Product's wallet (WAL-8 / SPEND). */
export const NORTHWIND_AGENTS = [{ name: 'Research', drive: 'product' as const }] as const;
export const NORTHWIND_WORKFLOWS = [{ name: 'Weekly digest', drive: 'product' as const, cadence: 'weekly' as const }] as const;

export interface NorthwindSeed {
  users: Record<NorthwindPerson['key'], string>;
  drives: Record<NorthwindDriveKey, string>;
}

/**
 * Seed the people and the six drives. Every drive is owned by Jono today: an org cannot own
 * a drive until B1 lands, and the visibility and wallet numbers above are what the org lanes
 * apply once their tables exist. Emails are generated unique by the factory so the seed is
 * safe to run repeatedly against an accumulating e2e database.
 */
export async function seedNorthwind(): Promise<NorthwindSeed> {
  const users = {} as Record<NorthwindPerson['key'], string>;
  for (const person of NORTHWIND_PEOPLE) {
    const user = await factories.createUser({ name: person.name });
    users[person.key] = user.id;
  }
  const drives = {} as Record<NorthwindDriveKey, string>;
  for (const drive of NORTHWIND_DRIVES) {
    const row = await factories.createDrive(users.jono, {
      name: drive.name,
      // drives.slug carries a plain (owner, slug) index, not a unique constraint; the random
      // suffix only keeps repeated seeds distinguishable in an accumulating e2e database.
      slug: `${NORTHWIND_ORG.slug}-${drive.key.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    drives[drive.key] = row.id;
  }
  return { users, drives };
}
