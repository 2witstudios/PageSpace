/**
 * End-to-end GDPR pseudonymization via the eraser role on the Admin PG
 * (#890 Phase 2, leaf 6 — the acceptance proof).
 *
 * Connected AS the provisioned admin_gdpr_eraser_user LOGIN over the wire
 * (no SET ROLE, no owner shortcuts), against a REAL chainer-era chain built
 * with the production hash functions:
 *
 *   1. genesis→head verifies BEFORE erasure,
 *   2. pseudonymizeSecurityAuditLogForUser nulls the subject's PII columns
 *      (including ip_bidx) and ONLY the subject's,
 *   3. genesis→head STILL verifies AFTER — erasure is provably chain-safe
 *      because emission/chain hashes exclude PII by design,
 *   4. the eraser connection CANNOT touch hash columns or INSERT/DELETE
 *      (real 42501, Phase 1 grant-denial pattern).
 *
 * Requires a running scratch Postgres (never the app DB):
 *   docker run --rm -d --name pagespace-admin-smoke -p 55432:5432 \
 *     -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=pagespace_admin postgres:16
 *   ADMIN_DATABASE_URL=postgresql://admin:admin@localhost:55432/pagespace_admin \
 *     bunx vitest run src/compliance/erasure/__tests__/gdpr-eraser.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { sql } from 'drizzle-orm';
import { migrateAdminDb } from '@pagespace/db/migrate-admin';
import { provisionAdminLoginUsers } from '@pagespace/db/provision-admin-users';
import {
  createAdminAuditDbClient,
  type AdminAuditDbClient,
} from '@pagespace/db/admin-eraser-db';
import { securityAuditLog } from '@pagespace/db/admin-schema';
import { computeEmissionHash } from '../../../audit/emission-hash';
import { computeChainHash, GENESIS_PREVIOUS_HASH } from '../../../audit/chain-step';
import { verifySecurityAuditChain } from '../../../audit/security-audit-chain-verifier';
import type { AuditEvent } from '../../../audit/security-audit';
import { pseudonymizeSecurityAuditLogForUser } from '../pseudonymize-repository';

const url = process.env.ADMIN_DATABASE_URL;

const ERASER_PASSWORD = 'eraser-secret-e2e-1';
const SUBJECT = 'subject-user';
const BYSTANDER = 'other-user';

const ALL_ROLES = [
  'admin_app',
  'admin_chainer',
  'admin_gdpr_eraser',
  'admin_reader',
  'admin_siem',
  'admin_maintenance',
  'admin_app_user',
  'admin_processor_user',
  'admin_reader_user',
  'admin_gdpr_eraser_user',
] as const;

const eraserUrl = (): string => {
  const parsed = new URL(url as string);
  parsed.username = 'admin_gdpr_eraser_user';
  parsed.password = ERASER_PASSWORD;
  return parsed.toString();
};

/** Build one chainer-era row with the production hash functions. */
function buildChainedRow(i: number, userId: string, previousHash: string) {
  const timestamp = new Date(Date.UTC(2026, 5, 1, 0, 0, i));
  const event: AuditEvent = {
    eventType: 'auth.login.success',
    userId,
    serviceId: 'web',
    details: { probe: 'gdpr-eraser-e2e', i },
  };
  const emissionHash = computeEmissionHash(event, timestamp);
  const eventHash = computeChainHash(emissionHash, previousHash);
  return {
    eventHash,
    values: {
      id: `e2e-row-${i}`,
      eventType: event.eventType,
      userId,
      sessionId: `session-${userId}-${i}`,
      serviceId: 'web',
      ipAddress: `203.0.113.${i}`,
      ipBidx: `bidx-${userId}-${i}`,
      userAgent: 'e2e-agent/1.0',
      geoLocation: 'EU',
      details: event.details as Record<string, unknown>,
      timestamp,
      previousHash,
      eventHash,
      emissionHash,
    },
  };
}

describe.skipIf(!url)('GDPR pseudonymization via admin_gdpr_eraser_user (wire-connected)', () => {
  let owner: AdminAuditDbClient;
  let eraser: AdminAuditDbClient;

  beforeAll(async () => {
    owner = createAdminAuditDbClient({ connectionString: url as string, max: 3 });

    // Fresh-DB guarantee on the SCRATCH db — same reset as the db package's
    // admin integration suites, including LOGIN users so provisioning runs.
    await owner.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
    await owner.db.execute(sql`DROP SCHEMA IF EXISTS drizzle_admin CASCADE`);
    await owner.db.execute(sql`CREATE SCHEMA public`);
    for (const role of ALL_ROLES) {
      await owner.db.execute(
        sql.raw(`
          DO $$ BEGIN
            IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
              DROP OWNED BY ${role};
              DROP ROLE ${role};
            END IF;
          END $$;
        `),
      );
    }

    // migrateAdminDb resolves its migrations folder relative to CWD
    // (packages/db convention) — hop there for the migration call only.
    const previousCwd = process.cwd();
    process.chdir(path.resolve(__dirname, '../../../../../db'));
    try {
      await migrateAdminDb({ ADMIN_DATABASE_URL: url });
    } finally {
      process.chdir(previousCwd);
    }

    const provisioned = await provisionAdminLoginUsers({
      ADMIN_DATABASE_URL: url,
      ADMIN_ERASER_PASSWORD: ERASER_PASSWORD,
    });
    expect(provisioned.provisioned).toEqual(['admin_gdpr_eraser_user']);

    // Seed a REAL 5-row chain: subject rows interleaved with a bystander's.
    let previousHash = GENESIS_PREVIOUS_HASH;
    for (let i = 0; i < 5; i++) {
      const built = buildChainedRow(i, i % 2 === 0 ? SUBJECT : BYSTANDER, previousHash);
      await owner.db.insert(securityAuditLog).values(built.values);
      previousHash = built.eventHash;
    }

    eraser = createAdminAuditDbClient({ connectionString: eraserUrl(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), eraser?.end()]);
  });

  it('given the seeded chain, should verify genesis→head BEFORE erasure', async () => {
    const result = await verifySecurityAuditChain({}, { db: owner.db });
    expect(result.isValid).toBe(true);
    expect(result.entriesVerified).toBe(5);
    expect(result.invalidEntries).toBe(0);
  });

  it('given the subject, should null exactly the subject PII (incl. ip_bidx) via the eraser connection AND the chain must still verify', async () => {
    const rows = await pseudonymizeSecurityAuditLogForUser(SUBJECT, { db: eraser.db });
    expect(rows).toBe(3);

    const after = await owner.db.query.securityAuditLog.findMany({
      orderBy: (t, { asc }) => [asc(t.chainSeq)],
    });
    expect(after).toHaveLength(5);
    for (const row of after) {
      if (row.id === 'e2e-row-0' || row.id === 'e2e-row-2' || row.id === 'e2e-row-4') {
        // Subject rows: every erasable PII column is gone…
        expect(row.ipAddress).toBeNull();
        expect(row.ipBidx).toBeNull();
        expect(row.userAgent).toBeNull();
        expect(row.geoLocation).toBeNull();
        expect(row.sessionId).toBeNull();
      } else {
        // …bystander rows are untouched.
        expect(row.ipAddress).not.toBeNull();
        expect(row.ipBidx).not.toBeNull();
        expect(row.userAgent).not.toBeNull();
      }
    }

    // The erasure is chain-safe: hashes exclude PII by design, so the full
    // genesis→head verification still passes — read via the ERASER connection
    // (SELECT is in its grant) and cross-checked via the owner.
    const viaEraser = await verifySecurityAuditChain({}, { db: eraser.db });
    expect(viaEraser.isValid).toBe(true);
    expect(viaEraser.entriesVerified).toBe(5);
    expect(viaEraser.invalidEntries).toBe(0);

    const viaOwner = await verifySecurityAuditChain({}, { db: owner.db });
    expect(viaOwner.isValid).toBe(true);
  });

  it('the eraser connection CANNOT touch hash columns, INSERT, or DELETE (real 42501)', async () => {
    const expect42501 = async (promise: Promise<unknown>) => {
      const error = await promise.then(
        () => null,
        (e: unknown) => e as { code?: string; cause?: { code?: string } },
      );
      expect(error).not.toBeNull();
      expect(error!.code ?? error!.cause?.code).toBe('42501');
    };

    await expect42501(
      eraser.db.execute(
        sql`UPDATE security_audit_log SET event_hash = 'tampered' WHERE id = 'e2e-row-0'`,
      ),
    );
    await expect42501(
      eraser.db.execute(
        sql`UPDATE security_audit_log SET previous_hash = 'tampered' WHERE id = 'e2e-row-0'`,
      ),
    );
    await expect42501(
      eraser.db.execute(
        sql`UPDATE security_audit_log SET emission_hash = 'tampered' WHERE id = 'e2e-row-0'`,
      ),
    );
    await expect42501(
      eraser.db.execute(
        sql`INSERT INTO security_audit_log (id, event_type, previous_hash, event_hash)
            VALUES ('eraser-insert', 'auth.login.success', 'x', 'y')`,
      ),
    );
    await expect42501(
      eraser.db.execute(sql`DELETE FROM security_audit_log WHERE id = 'e2e-row-0'`),
    );

    // Nothing above may have changed the chain.
    const still = await verifySecurityAuditChain({}, { db: owner.db });
    expect(still.isValid).toBe(true);
  });
});
