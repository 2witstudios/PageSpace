import { describe, it } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { resolveSiemPoolRouting } from '../siem-pool-routing';

const ADMIN_URL = 'postgresql://admin_processor_user:pw@admin-host:5432/pagespace_admin';

describe('resolveSiemPoolRouting', () => {
  it('given a dedicated Admin PG (ADMIN_DATABASE_URL set), should pin the full pool-per-operation matrix', () => {
    const { decision, routing } = resolveSiemPoolRouting({ ADMIN_DATABASE_URL: ADMIN_URL });

    assert({
      given: 'ADMIN_DATABASE_URL set',
      should: 'resolve mode dedicated',
      actual: decision.mode,
      expected: 'dedicated',
    });

    // THE pool-per-operation matrix (#890 Phase 2 leaf 7). Changing any cell
    // is a cutover-semantics change — cursors/receipts live in the Admin PG,
    // security_audit_log data moved there, activity_logs data has NOT moved
    // (Phase 5), and the advisory lock stays on main so old and new workers
    // keep serializing against each other across a rolling deploy.
    assert({
      given: 'dedicated mode',
      should: 'route each operation to its store plane',
      actual: routing,
      expected: {
        mode: 'dedicated',
        advisoryLock: 'main',
        cursors: 'admin',
        receipts: 'admin',
        data: {
          activity_logs: 'main',
          security_audit_log: 'admin',
        },
        seedCursorFromLegacy: true,
        awaitingBackfillProbe: true,
      },
    });
  });

  it('given break-glass (URL unset, flag armed), should route every operation to main — the exact legacy worker', () => {
    const { decision, routing } = resolveSiemPoolRouting({
      ADMIN_DATABASE_URL: undefined,
      ADMIN_DB_BREAK_GLASS: 'true',
    });

    assert({
      given: 'break-glass env',
      should: 'resolve mode break-glass',
      actual: decision.mode,
      expected: 'break-glass',
    });
    assert({
      given: 'break-glass mode',
      should: 'route everything to the main pool with no seed/probe behavior',
      actual: routing,
      expected: {
        mode: 'break-glass',
        advisoryLock: 'main',
        cursors: 'main',
        receipts: 'main',
        data: {
          activity_logs: 'main',
          security_audit_log: 'main',
        },
        seedCursorFromLegacy: false,
        awaitingBackfillProbe: false,
      },
    });
  });

  it('given no admin URL and no flags (main-db default), should route every operation to main — silently, like the legacy worker', () => {
    const { decision, routing } = resolveSiemPoolRouting({});

    assert({
      given: 'unconfigured trust plane, no enforcement flag',
      should: 'resolve mode main-db (the silent pre-trust-plane default)',
      actual: decision.mode,
      expected: 'main-db',
    });
    assert({
      given: 'main-db mode',
      should: 'route everything to the main pool, identical to break-glass but silent',
      actual: routing,
      expected: {
        mode: 'main-db',
        advisoryLock: 'main',
        cursors: 'main',
        receipts: 'main',
        data: {
          activity_logs: 'main',
          security_audit_log: 'main',
        },
        seedCursorFromLegacy: false,
        awaitingBackfillProbe: false,
      },
    });
  });

  it('given AUDIT_TRUST_PLANE_REQUIRED armed but no URL, should return no routing (worker halts loudly)', () => {
    const { decision, routing } = resolveSiemPoolRouting({ AUDIT_TRUST_PLANE_REQUIRED: 'true' });

    assert({
      given: 'trust plane declared required but unconfigured',
      should: 'resolve mode fail',
      actual: decision.mode,
      expected: 'fail',
    });
    assert({
      given: 'fail mode',
      should: 'provide no routing',
      actual: routing,
      expected: null,
    });
  });

  it('given a malformed ADMIN_DATABASE_URL even with break-glass armed, should fail (never silently degrade a typo)', () => {
    const { decision, routing } = resolveSiemPoolRouting({
      ADMIN_DATABASE_URL: 'not-a-url',
      ADMIN_DB_BREAK_GLASS: 'true',
    });

    assert({
      given: 'invalid admin URL',
      should: 'resolve mode fail',
      actual: decision.mode,
      expected: 'fail',
    });
    assert({
      given: 'invalid admin URL',
      should: 'provide no routing',
      actual: routing,
      expected: null,
    });
  });
});
