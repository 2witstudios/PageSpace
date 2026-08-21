import { getMigrationDb } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { createId } from '@paralleldrive/cuid2';
import { createEmptySheet, serializeSheetContent } from '@pagespace/lib/sheets/sheet';
import { sessionService } from '@pagespace/lib/auth/session-service';

const db = getMigrationDb();

const userId = createId();
const driveId = createId();
const pageId = createId();

await db.insert(users).values({
  id: userId,
  name: 'Sheet Tester',
  email: 'sheets@local.test',
  provider: 'email',
  role: 'user',
});

await db.insert(drives).values({
  id: driveId,
  name: 'Verification',
  slug: `verification-${Date.now()}`,
  ownerId: userId,
});

await db.insert(driveMembers).values({
  id: createId(), driveId, userId, role: 'OWNER', acceptedAt: new Date(),
});

const sheet = createEmptySheet();
Object.assign(sheet.cells, {
  A1: 'Region', B1: 'Q1', C1: 'Q2', D1: 'Total',
  A2: 'North',  B2: '125000', C2: '138500', D2: '=B2+C2',
  A3: 'South',  B3: '98000',  C3: '104200', D3: '=B3+C3',
  A4: 'East',   B4: '156300', C4: '149800', D4: '=B4+C4',
  A5: 'West',   B5: '87400',  C5: '92100',  D5: '=B5+C5',
  A6: 'Total',  B6: '=SUM(B2:B5)', C6: '=SUM(C2:C5)', D6: '=SUM(D2:D5)',
});

await db.insert(pages).values({
  id: pageId, title: 'Regional Budget', type: 'SHEET',
  content: serializeSheetContent(sheet), driveId, position: 1000,
});

const token = await sessionService.createSession({
  userId, type: 'user', scopes: ['*'], expiresInMs: 24 * 60 * 60 * 1000,
});

console.log('SEED ' + JSON.stringify({ userId, driveId, pageId, token }));
process.exit(0);
