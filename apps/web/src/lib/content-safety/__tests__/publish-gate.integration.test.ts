/**
 * The publish gate end to end, against a REAL Postgres: POST
 * /api/pages/[pageId]/publish with a real session, real permissions, the real
 * asset pipeline, the real gate, the real verdict and case tables and the real
 * alert email builder. Only storage, the vendor and the mail transport are
 * replaced: the scanner is the fake one, configured per hash; the private
 * bucket serves harmless PNG bytes; the publish bucket records what is copied.
 *
 * Never real illegal content: the "flagged" image is eight bytes of PNG header
 * that the fake scanner is told to flag.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import { createRequire } from 'module';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { contentCases, contentScans } from '@pagespace/db/schema/content-safety';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import type { ScanResult } from '@pagespace/lib/content-safety/scanner';
import { COOKIE_CONFIG } from '@/lib/auth/cookie-config';
import { ensureTestDb } from '@/test/ensure-test-db';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const newHash = () => createHash('sha256').update(randomUUID()).digest('hex');
const FLAGGED = newHash();
const CLEAN = newHash();

// The vendor: the fake scanner, one result per hash.
const scanResults = vi.hoisted(() => new Map<string, ScanResult>());
vi.mock('@pagespace/lib/content-safety/scanner-hive', async () => {
  const { createFakeScanner } = await import('@pagespace/lib/content-safety/scanner');
  return {
    createHiveScanner: () => {
      const results: Record<string, ScanResult> = {};
      return createFakeScanner({
        results: new Proxy(results, { get: (_t, hash: string) => scanResults.get(hash) }),
        provider: 'fake',
      });
    },
  };
});

// The private uploads bucket: every original is a tiny PNG.
vi.mock('@/lib/presigned-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/presigned-url')>();
  return {
    ...actual,
    getS3Bucket: () => 'private-test',
    getS3Client: () => ({
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: PNG.length };
        if (command.constructor.name === 'GetObjectCommand') return { Body: { transformToByteArray: async () => PNG } };
        throw new Error(`unexpected ${command.constructor.name}`);
      },
    }),
  };
});

// The publish bucket: record copies and artifact writes, never touch S3.
const copied = vi.hoisted(() => [] as string[]);
const artifacts = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/canvas/published-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/canvas/published-storage')>();
  return {
    ...actual,
    isPublishConfigured: () => true,
    copyObjectToPublishBucket: async ({ assetKey }: { assetKey: string }) => {
      copied.push(assetKey);
    },
    putPublishedArtifact: async ({ html }: { html: string }) => {
      artifacts.push(html);
    },
    putPublishedSiteFile: async () => undefined,
    publishedArtifactExists: async () => true,
    deletePublishedArtifact: async () => undefined,
    copyPublishedArtifact: async () => undefined,
  };
});
vi.mock('@/lib/canvas/custom-domain-mirror', () => ({
  mirrorPublishedPageToHosts: async () => undefined,
  mirror404ToHosts: async () => undefined,
  getActiveDomainRecords: async () => [],
  deletePageFromCustomHosts: async () => undefined,
}));

// The mail transport: capture what the abuse inbox would receive. The lib is loaded as
// CommonJS outside vite, so vi.mock cannot reach its internal import; the alert module reads
// `sendEmail` off this exports object at call time, so replacing it there intercepts the send.
const sent = [] as Array<{ to: string; subject: string; react: unknown }>;
const emailService = createRequire(import.meta.url)('@pagespace/lib/services/email-service') as {
  sendEmail: (options: { to: string; subject: string; react: unknown }) => Promise<void>;
};
const realSendEmail = emailService.sendEmail;

const { POST } = await import('@/app/api/pages/[pageId]/publish/route');

const APP_ORIGIN = 'http://localhost:3000';
const seededUserIds: string[] = [];
const ENV_KEYS = ['WEB_APP_URL', 'CONTENT_SCAN_MODE', 'HIVE_API_KEY', 'PUBLISH_BUCKET', 'PUBLISH_ASSET_BASE_URL', 'ADMIN_APP_URL', 'DEPLOYMENT_MODE'] as const;
const previousEnv = new Map<string, string | undefined>();

async function publishAs(userId: string, pageId: string) {
  const token = await sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 3_600_000, authentication: null });
  const claims = await sessionService.validateSession(token);
  if (!claims) throw new Error('session did not validate');
  return POST(
    new Request(`http://localhost/api/pages/${pageId}/publish`, {
      method: 'POST',
      headers: {
        cookie: `${COOKIE_CONFIG.session.name}=${token}`,
        'content-type': 'application/json',
        origin: APP_ORIGIN,
        'x-csrf-token': generateCSRFToken(claims.sessionId),
      },
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ pageId }) },
  );
}

async function seedSite(mode: 'shadow' | 'enforce') {
  process.env.CONTENT_SCAN_MODE = mode;
  const user = await factories.createUser();
  seededUserIds.push(user.id);
  const drive = await factories.createDrive(user.id, { name: `Site ${mode}` });
  const flaggedFile = await factories.createPage(drive.id, { type: 'FILE', title: 'a.png', contentHash: FLAGGED, mimeType: 'image/png' });
  const cleanFile = await factories.createPage(drive.id, { type: 'FILE', title: 'b.png', contentHash: CLEAN, mimeType: 'image/png' });
  const canvas = await factories.createPage(drive.id, {
    type: 'CANVAS',
    title: `Gallery ${mode}`,
    content: `<img src="/api/files/${flaggedFile.id}/view"><img src="/api/files/${cleanFile.id}/view">`,
  });
  return { user, drive, flaggedFile, cleanFile, canvas };
}

beforeAll(async () => {
  await ensureTestDb();
  for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
  process.env.WEB_APP_URL = APP_ORIGIN;
  process.env.HIVE_API_KEY = 'test-key';
  process.env.PUBLISH_BUCKET = 'publish-test';
  process.env.PUBLISH_ASSET_BASE_URL = 'https://publish-test.t3.tigrisfiles.io';
  process.env.ADMIN_APP_URL = 'https://admin.example.test';
  delete process.env.DEPLOYMENT_MODE;
  emailService.sendEmail = async (options) => {
    sent.push(options);
  };
  scanResults.set(FLAGGED, { kind: 'classifier_flag', provider: 'fake', category: 'csam', score: 0.97 });
});

beforeEach(() => {
  copied.length = 0;
  artifacts.length = 0;
  sent.length = 0;
});

afterAll(async () => {
  emailService.sendEmail = realSendEmail;
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await db.delete(contentCases).where(inArray(contentCases.targetId, [FLAGGED, CLEAN]));
  await db.delete(contentScans).where(inArray(contentScans.contentHash, [FLAGGED, CLEAN]));
  if (seededUserIds.length > 0) await db.delete(users).where(inArray(users.id, seededUserIds));
});

describe('publish gate (integration, fake scanner)', () => {
  it('enforce: a flagged image is held and listed, a review case is opened, the alert carries no file link', async () => {
    const { user, flaggedFile, cleanFile, canvas } = await seedSite('enforce');

    const res = await publishAs(user.id, canvas.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { heldAssets: string[]; url: string };

    // Held: listed by file ID only, never copied, its private reference left in place.
    expect(body.heldAssets).toEqual([flaggedFile.id]);
    expect(JSON.stringify(body)).not.toContain(FLAGGED);
    expect(copied).toEqual([`assets/${CLEAN}`]);
    expect(artifacts.at(-1)).toContain(`/api/files/${flaggedFile.id}/view`);
    expect(artifacts.at(-1)).toContain(`https://publish-test.t3.tigrisfiles.io/assets/${CLEAN}`);
    expect(artifacts.at(-1)).not.toContain(`/api/files/${cleanFile.id}/view`);

    // Verdicts recorded for both.
    const verdicts = await db.select().from(contentScans).where(inArray(contentScans.contentHash, [FLAGGED, CLEAN]));
    expect(verdicts.find((v) => v.contentHash === FLAGGED)).toMatchObject({ verdict: 'flagged', outcome: 'classifier_flag', mode: 'enforce', provider: 'fake' });
    expect(verdicts.find((v) => v.contentHash === CLEAN)).toMatchObject({ verdict: 'clean', mode: 'enforce' });

    // A case in the review queue; nothing blocked.
    const [reviewCase] = await db.select().from(contentCases).where(eq(contentCases.targetId, FLAGGED));
    expect(reviewCase).toMatchObject({ status: 'reported', targetType: 'content_hash', category: 'csam' });
    expect(reviewCase.snapshot?.scan).toMatchObject({ source: 'scan_flagged', score: 0.97, mode: 'enforce' });

    // One urgent alert, with the case and an admin link — no asset URL, hash, file ID or filename.
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/^\[URGENT\] Suspected CSAM/);
    const html = renderToStaticMarkup(sent[0].react as ReactElement);
    expect(html).toContain(reviewCase.id);
    for (const leak of [FLAGGED, flaggedFile.id, 'a.png', 'tigrisfiles', '/assets/', '/api/files/', 'files/']) {
      expect(html).not.toContain(leak);
    }
    const links = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(links).toEqual([`https://admin.example.test/content?case=${reviewCase.id}`]);

    // A republish within the TTL holds again without a second case or alert.
    const again = await publishAs(user.id, canvas.id);
    expect(((await again.json()) as { heldAssets: string[] }).heldAssets).toEqual([flaggedFile.id]);
    expect(sent).toHaveLength(1);
    expect(await db.select().from(contentCases).where(eq(contentCases.targetId, FLAGGED))).toHaveLength(1);
  });

  it('shadow: the same flagged image is published, but still recorded and queued', async () => {
    await db.delete(contentScans).where(eq(contentScans.contentHash, FLAGGED));
    const { user, canvas } = await seedSite('shadow');

    const res = await publishAs(user.id, canvas.id);
    const body = (await res.json()) as { heldAssets: string[] };

    expect(body.heldAssets).toEqual([]);
    expect(copied.sort()).toEqual([`assets/${CLEAN}`, `assets/${FLAGGED}`].sort());
    const [verdict] = await db.select().from(contentScans).where(eq(contentScans.contentHash, FLAGGED));
    expect(verdict).toMatchObject({ verdict: 'flagged', mode: 'shadow' });
    // Joins the case already under review from the first test rather than opening a second.
    const cases = await db.select().from(contentCases).where(eq(contentCases.targetId, FLAGGED));
    expect(cases).toHaveLength(1);
    expect(cases[0].snapshot?.scan).toMatchObject({ mode: 'shadow' });
  });
});
