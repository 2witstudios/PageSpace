import { describe, it, vi } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';

// The barrel binds defaultRollbackDeps() at module load, which references the db
// connection and effect modules. Stub the connection so importing the surface
// does not open a real DB.
vi.mock('@pagespace/db/db', () => ({ db: {} }));

import * as barrel from '../index';

describe('rollback barrel public surface', () => {
  it('exports the six public functions', () => {
    assert({
      given: 'the rollback barrel',
      should: 'export getActivityById, previewRollback, executeRollback, getPageVersionHistory, getDriveVersionHistory, getUserRetentionDays as functions',
      actual: [
        typeof barrel.getActivityById,
        typeof barrel.previewRollback,
        typeof barrel.executeRollback,
        typeof barrel.getPageVersionHistory,
        typeof barrel.getDriveVersionHistory,
        typeof barrel.getUserRetentionDays,
      ],
      expected: ['function', 'function', 'function', 'function', 'function', 'function'],
    });
  });
});
