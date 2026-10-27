/**
 * Pure core for global-teardown.ts (PR #2642 review thread PRRC_kwDOPhnPxc7vh_S1): global-setup
 * seeds the Northwind Labs fixture's eight users (and, via `drives.ownerId` cascade, its six
 * drives) in addition to the original top-level user, but teardown deleted only the top-level
 * `userId`. Every completed Playwright run against the reusable local database therefore left
 * eight users and six drives behind permanently. `collectSeedUserIds` is the one place that
 * decides which user rows a run must delete; global-teardown.ts is a thin IO caller over it.
 */
import { describe, expect, it } from 'vitest';
import { collectSeedUserIds } from '../teardown-plan';
import type { SeedState } from '../../fixtures/seed-state';

describe('e2e teardown: collectSeedUserIds', () => {
  it('includes the top-level seed user when there is no Northwind fixture (pre-lane-A4 seed files)', () => {
    const state: SeedState = { userId: 'user_top', driveId: 'drive_top' };
    expect(collectSeedUserIds(state)).toEqual(['user_top']);
  });

  it('includes every Northwind Labs user id alongside the top-level user', () => {
    const state: SeedState = {
      userId: 'user_top',
      driveId: 'drive_top',
      northwind: {
        users: {
          jono: 'user_jono',
          priya: 'user_priya',
          dana: 'user_dana',
          marcus: 'user_marcus',
          lena: 'user_lena',
          tomas: 'user_tomas',
          chris: 'user_chris',
          aisha: 'user_aisha',
        },
        drives: {
          product: 'drive_product',
          designSystem: 'drive_design',
          marketingSite: 'drive_marketing',
          customerResearch: 'drive_research',
          engineering: 'drive_eng',
          finance: 'drive_finance',
        },
      },
    };
    const ids = collectSeedUserIds(state);
    expect(ids).toContain('user_top');
    for (const id of ['user_jono', 'user_priya', 'user_dana', 'user_marcus', 'user_lena', 'user_tomas', 'user_chris', 'user_aisha']) {
      expect(ids).toContain(id);
    }
    expect(ids).toHaveLength(9);
  });

  it('never returns a duplicate id even if a caller happened to reuse one', () => {
    const state: SeedState = {
      userId: 'user_top',
      driveId: 'drive_top',
      northwind: {
        users: {
          jono: 'user_top',
          priya: 'user_priya',
          dana: 'user_dana',
          marcus: 'user_marcus',
          lena: 'user_lena',
          tomas: 'user_tomas',
          chris: 'user_chris',
          aisha: 'user_aisha',
        },
        drives: {} as SeedState['northwind'] extends infer T ? (T extends { drives: infer D } ? D : never) : never,
      },
    };
    expect(collectSeedUserIds(state)).toEqual(
      expect.arrayContaining(['user_top', 'user_priya', 'user_dana', 'user_marcus', 'user_lena', 'user_tomas', 'user_chris', 'user_aisha']),
    );
    expect(collectSeedUserIds(state)).toHaveLength(8);
  });
});
