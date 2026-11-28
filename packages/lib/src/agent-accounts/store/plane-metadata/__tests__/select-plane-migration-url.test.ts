/**
 * Slice 1 (deploy) — which connection string the migration one-shot uses.
 * On Fly the one-shot runs inside the plane's app, so it inherits the plane's
 * runtime PLANE_METADATA_DATABASE_URL (a login that cannot run DDL) and an app
 * secret beats a same-named --env. The owner URL therefore travels under its
 * own name and wins whenever it is set.
 */
import { describe, expect, it } from 'vitest';
import { selectPlaneMigrationUrl } from '../plan-plane-migrations';

const RUNTIME = 'postgresql://plane_app:pw@pagespace-plane-db.internal:5432/plane_metadata';
const OWNER = 'postgresql://plane_owner:pw@pagespace-plane-db.internal:5432/plane_metadata';

describe('selectPlaneMigrationUrl', () => {
  it('given both the owner and the runtime URL, should use the owner URL', () => {
    expect(selectPlaneMigrationUrl({ PLANE_METADATA_DATABASE_URL_MIGRATE: OWNER, PLANE_METADATA_DATABASE_URL: RUNTIME })).toBe(OWNER);
  });

  it('given only the runtime URL (local dev, CI), should use it', () => {
    expect(selectPlaneMigrationUrl({ PLANE_METADATA_DATABASE_URL: RUNTIME })).toBe(RUNTIME);
  });

  it('given an empty or blank owner URL, should treat it as unset', () => {
    const actual = [
      selectPlaneMigrationUrl({ PLANE_METADATA_DATABASE_URL_MIGRATE: '', PLANE_METADATA_DATABASE_URL: RUNTIME }),
      selectPlaneMigrationUrl({ PLANE_METADATA_DATABASE_URL_MIGRATE: '  ', PLANE_METADATA_DATABASE_URL: RUNTIME }),
    ];
    expect(actual).toEqual([RUNTIME, RUNTIME]);
  });

  it('given neither, should return null', () => {
    expect(selectPlaneMigrationUrl({})).toBe(null);
  });
});
