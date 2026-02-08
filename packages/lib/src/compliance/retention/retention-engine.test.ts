import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db, users, sessions, socketTokens, verificationTokens, emailUnsubscribeTokens, pageVersions, driveBackups, aiUsageLogs } from '@pagespace/db';
import { driveInvitations, pagePermissions } from '@pagespace/db';
import { pulseSummaries } from '@pagespace/db';
import { drives, pages } from '@pagespace/db';
import { eq, and, lt } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import {
  cleanupExpiredSessions,
  cleanupExpiredVerificationTokens,
  cleanupExpiredSocketTokens,
  cleanupExpiredEmailUnsubscribeTokens,
  cleanupExpiredPulseSummaries,
  cleanupExpiredPageVersions,
  cleanupExpiredDriveBackups,
  cleanupExpiredDriveInvitations,
  cleanupExpiredPagePermissions,
  cleanupExpiredAiUsageLogs,
  runRetentionCleanup,
} from './retention-engine';
import { createHash } from 'crypto';

const pastDate = new Date(Date.now() - 86400000); // 1 day ago
const futureDate = new Date(Date.now() + 86400000); // 1 day from now

let testUserId: string;
let testDriveId: string;

beforeEach(async () => {
  const [user] = await db.insert(users).values({
    id: createId(),
    name: 'Retention Test User',
    email: `retention-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: 'hashed_password',
    provider: 'email',
    role: 'user',
    tokenVersion: 1,
  }).returning();
  testUserId = user.id;

  const [drive] = await db.insert(drives).values({
    id: createId(),
    name: 'Retention Test Drive',
    slug: `retention-test-${Date.now()}`,
    ownerId: testUserId,
    updatedAt: new Date(),
  }).returning();
  testDriveId = drive.id;
});

afterEach(async () => {
  // Cleanup in reverse dependency order
  await db.delete(drives).where(eq(drives.id, testDriveId));
  await db.delete(users).where(eq(users.id, testUserId));
});

describe('cleanupExpiredSessions', () => {
  it('deletes sessions past expiresAt', async () => {
    const tokenHash = createHash('sha256').update(`sess-expired-${Date.now()}`).digest('hex');
    await db.insert(sessions).values({
      id: createId(),
      tokenHash,
      tokenPrefix: 'ps_sess_',
      userId: testUserId,
      type: 'user',
      scopes: ['*'],
      tokenVersion: 1,
      expiresAt: pastDate,
    });

    const result = await cleanupExpiredSessions(db);

    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });

  it('does not delete sessions with future expiresAt', async () => {
    const tokenHash = createHash('sha256').update(`sess-future-${Date.now()}`).digest('hex');
    const [created] = await db.insert(sessions).values({
      id: createId(),
      tokenHash,
      tokenPrefix: 'ps_sess_',
      userId: testUserId,
      type: 'user',
      scopes: ['*'],
      tokenVersion: 1,
      expiresAt: futureDate,
    }).returning();

    await cleanupExpiredSessions(db);

    const remaining = await db.query.sessions.findFirst({
      where: eq(sessions.id, created.id),
    });
    expect(remaining).toBeTruthy();

    // cleanup
    await db.delete(sessions).where(eq(sessions.id, created.id));
  });
});

describe('cleanupExpiredVerificationTokens', () => {
  it('deletes verification tokens past expiresAt', async () => {
    const tokenHash = createHash('sha256').update(`vt-expired-${Date.now()}`).digest('hex');
    await db.insert(verificationTokens).values({
      id: createId(),
      userId: testUserId,
      tokenHash,
      tokenPrefix: 'ps_vt_',
      type: 'email_verification',
      expiresAt: pastDate,
    });

    const result = await cleanupExpiredVerificationTokens(db);

    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });
});

describe('cleanupExpiredSocketTokens', () => {
  it('deletes socket tokens past expiresAt', async () => {
    const tokenHash = createHash('sha256').update(`st-expired-${Date.now()}`).digest('hex');
    await db.insert(socketTokens).values({
      id: createId(),
      userId: testUserId,
      tokenHash,
      expiresAt: pastDate,
    });

    const result = await cleanupExpiredSocketTokens(db);

    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });
});

describe('cleanupExpiredEmailUnsubscribeTokens', () => {
  it('deletes email unsubscribe tokens past expiresAt', async () => {
    const tokenHash = createHash('sha256').update(`eut-expired-${Date.now()}`).digest('hex');
    await db.insert(emailUnsubscribeTokens).values({
      id: createId(),
      tokenHash,
      tokenPrefix: 'ps_eut_',
      userId: testUserId,
      notificationType: 'test',
      expiresAt: pastDate,
    });

    const result = await cleanupExpiredEmailUnsubscribeTokens(db);

    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });
});

describe('cleanupExpiredPulseSummaries', () => {
  it('deletes pulse summaries past expiresAt', async () => {
    await db.insert(pulseSummaries).values({
      id: createId(),
      userId: testUserId,
      summary: 'Test expired summary',
      periodStart: pastDate,
      periodEnd: pastDate,
      expiresAt: pastDate,
    });

    const result = await cleanupExpiredPulseSummaries(db);

    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });
});

describe('cleanupExpiredPageVersions', () => {
  let testPageId: string;

  beforeEach(async () => {
    const [page] = await db.insert(pages).values({
      id: createId(),
      title: 'Retention Test Page',
      type: 'DOCUMENT',
      driveId: testDriveId,
      position: 0,
      updatedAt: new Date(),
    }).returning();
    testPageId = page.id;
  });

  afterEach(async () => {
    await db.delete(pages).where(eq(pages.id, testPageId));
  });

  it('deletes unpinned page versions past expiresAt', async () => {
    await db.insert(pageVersions).values({
      id: createId(),
      pageId: testPageId,
      driveId: testDriveId,
      isPinned: false,
      expiresAt: pastDate,
    });

    const result = await cleanupExpiredPageVersions(db);

    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });

  it('does not delete pinned page versions past expiresAt', async () => {
    const [pinned] = await db.insert(pageVersions).values({
      id: createId(),
      pageId: testPageId,
      driveId: testDriveId,
      isPinned: true,
      expiresAt: pastDate,
    }).returning();

    await cleanupExpiredPageVersions(db);

    const remaining = await db.query.pageVersions.findFirst({
      where: eq(pageVersions.id, pinned.id),
    });
    expect(remaining).toBeTruthy();

    // cleanup
    await db.delete(pageVersions).where(eq(pageVersions.id, pinned.id));
  });
});

describe('cleanupExpiredDriveBackups', () => {
  it('deletes unpinned drive backups past expiresAt', async () => {
    await db.insert(driveBackups).values({
      id: createId(),
      driveId: testDriveId,
      isPinned: false,
      expiresAt: pastDate,
    });

    const result = await cleanupExpiredDriveBackups(db);

    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });

  it('does not delete pinned drive backups past expiresAt', async () => {
    const [pinned] = await db.insert(driveBackups).values({
      id: createId(),
      driveId: testDriveId,
      isPinned: true,
      expiresAt: pastDate,
    }).returning();

    await cleanupExpiredDriveBackups(db);

    const remaining = await db.query.driveBackups.findFirst({
      where: eq(driveBackups.id, pinned.id),
    });
    expect(remaining).toBeTruthy();

    // cleanup
    await db.delete(driveBackups).where(eq(driveBackups.id, pinned.id));
  });
});

describe('cleanupExpiredDriveInvitations', () => {
  it('deletes drive invitations past expiresAt with PENDING status', async () => {
    await db.insert(driveInvitations).values({
      id: createId(),
      driveId: testDriveId,
      email: 'expired-invite@test.com',
      invitedBy: testUserId,
      status: 'PENDING',
      expiresAt: pastDate,
    });

    const result = await cleanupExpiredDriveInvitations(db);

    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });
});

describe('cleanupExpiredPagePermissions', () => {
  let testPageId: string;

  beforeEach(async () => {
    const [page] = await db.insert(pages).values({
      id: createId(),
      title: 'Permission Test Page',
      type: 'DOCUMENT',
      driveId: testDriveId,
      position: 0,
      updatedAt: new Date(),
    }).returning();
    testPageId = page.id;
  });

  afterEach(async () => {
    await db.delete(pages).where(eq(pages.id, testPageId));
  });

  it('deletes page permissions past expiresAt', async () => {
    await db.insert(pagePermissions).values({
      id: createId(),
      pageId: testPageId,
      userId: testUserId,
      canView: true,
      expiresAt: pastDate,
    });

    const result = await cleanupExpiredPagePermissions(db);

    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });

  it('does not delete page permissions without expiresAt', async () => {
    const [perm] = await db.insert(pagePermissions).values({
      id: createId(),
      pageId: testPageId,
      userId: testUserId,
      canView: true,
      expiresAt: null,
    }).returning();

    await cleanupExpiredPagePermissions(db);

    const remaining = await db.query.pagePermissions.findFirst({
      where: eq(pagePermissions.id, perm.id),
    });
    expect(remaining).toBeTruthy();

    // cleanup
    await db.delete(pagePermissions).where(eq(pagePermissions.id, perm.id));
  });
});

describe('cleanupExpiredAiUsageLogs', () => {
  it('deletes AI usage logs past expiresAt', async () => {
    await db.insert(aiUsageLogs).values({
      id: createId(),
      userId: testUserId,
      provider: 'test',
      model: 'test-model',
      expiresAt: pastDate,
    });

    const result = await cleanupExpiredAiUsageLogs(db);

    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });

  it('does not delete AI usage logs without expiresAt', async () => {
    const [log] = await db.insert(aiUsageLogs).values({
      id: createId(),
      userId: testUserId,
      provider: 'test',
      model: 'test-model',
      expiresAt: null,
    }).returning();

    await cleanupExpiredAiUsageLogs(db);

    const remaining = await db.query.aiUsageLogs.findFirst({
      where: eq(aiUsageLogs.id, log.id),
    });
    expect(remaining).toBeTruthy();

    // cleanup
    await db.delete(aiUsageLogs).where(eq(aiUsageLogs.id, log.id));
  });
});

describe('runRetentionCleanup', () => {
  it('returns results for all tables', async () => {
    const results = await runRetentionCleanup(db);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(10);

    for (const result of results) {
      expect(result).toHaveProperty('table');
      expect(result).toHaveProperty('deleted');
      expect(typeof result.table).toBe('string');
      expect(typeof result.deleted).toBe('number');
    }
  });

  it('includes all expected table names', async () => {
    const results = await runRetentionCleanup(db);
    const tableNames = results.map(r => r.table).sort();

    expect(tableNames).toEqual([
      'ai_usage_logs',
      'drive_backups',
      'drive_invitations',
      'email_unsubscribe_tokens',
      'page_permissions',
      'page_versions',
      'pulse_summaries',
      'sessions',
      'socket_tokens',
      'verification_tokens',
    ]);
  });
});
