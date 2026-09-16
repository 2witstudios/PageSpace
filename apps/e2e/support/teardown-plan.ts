/**
 * Pure core for `global-teardown.ts`. `global-setup.ts` seeds the top-level user/drive AND (via
 * `seedNorthwind`) the eight Northwind Labs users, each owning one of its six drives. Both sets
 * of drives cascade-delete from `users` (`drives.ownerId` is `onDelete: 'cascade'`), so the only
 * thing teardown needs to compute is the full set of user ids to delete.
 */
import type { SeedState } from '../fixtures/seed-state';

/** Every user id this run seeded — the top-level user plus every Northwind Labs user, if seeded. */
export function collectSeedUserIds(state: SeedState): string[] {
  const ids = new Set<string>([state.userId]);
  if (state.northwind) {
    for (const id of Object.values(state.northwind.users)) ids.add(id);
  }
  return [...ids];
}
