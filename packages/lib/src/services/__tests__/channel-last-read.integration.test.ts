/**
 * channelMessageRepository.findChannelLastReadAt against a REAL Postgres — no
 * fake DB, no vi.mock.
 *
 * What only a real database can show: that the select keys on BOTH columns of
 * channel_read_status's (userId, channelId) primary key, so the viewer's
 * watermark is never another reader's or another channel's, and that the
 * timestamp comes back as the Date the route serialises.
 *
 * Every case seeds its own users, drive and channels and asserts only on
 * them, so the suite is safe on a shared database.
 *
 * Requires DATABASE_URL → a migrated Postgres. FAILS LOUDLY when none is
 * reachable; local runs without a database opt out with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { channelReadStatus } from '@pagespace/db/schema/chat';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { channelMessageRepository } from '../channel-message-repository';

let dbAvailable = false;

beforeAll(async () => {
  try {
    await db.select().from(pages).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('channel-last-read.integration.test.ts', error);
    dbAvailable = false;
  }
});

/** A viewer and another member, a drive, and two channels in it. */
async function seed() {
  const viewer = await factories.createUser();
  const other = await factories.createUser();
  const drive = await factories.createDrive(viewer.id);
  const channel = await factories.createPage(drive.id, { type: 'CHANNEL', title: 'launch' });
  const elsewhere = await factories.createPage(drive.id, { type: 'CHANNEL', title: 'general' });
  return { viewer, other, channel, elsewhere };
}

describe('channelMessageRepository.findChannelLastReadAt (real Postgres)', () => {
  it('given read rows for the viewer here, another reader here and the viewer elsewhere, should return only the viewer’s watermark in this channel', async () => {
    if (!dbAvailable) return;
    const { viewer, other, channel, elsewhere } = await seed();
    const mine = new Date('2026-10-05T09:30:00.000Z');
    await db.insert(channelReadStatus).values([
      { userId: other.id, channelId: channel.id, lastReadAt: new Date('2026-10-05T11:00:00.000Z') },
      { userId: viewer.id, channelId: elsewhere.id, lastReadAt: new Date('2026-10-05T12:00:00.000Z') },
      { userId: viewer.id, channelId: channel.id, lastReadAt: mine },
    ]);

    const result = await channelMessageRepository.findChannelLastReadAt({ userId: viewer.id, channelId: channel.id });

    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe(mine.toISOString());
  });

  it('given the viewer never read the channel while others did, should return null', async () => {
    if (!dbAvailable) return;
    const { viewer, other, channel, elsewhere } = await seed();
    await db.insert(channelReadStatus).values([
      { userId: other.id, channelId: channel.id, lastReadAt: new Date('2026-10-05T11:00:00.000Z') },
      { userId: viewer.id, channelId: elsewhere.id, lastReadAt: new Date('2026-10-05T12:00:00.000Z') },
    ]);

    const result = await channelMessageRepository.findChannelLastReadAt({ userId: viewer.id, channelId: channel.id });

    expect(result).toBeNull();
  });

  it('given the viewer’s watermark moved by the read upsert, should return the new one', async () => {
    if (!dbAvailable) return;
    const { viewer, channel } = await seed();
    const later = new Date('2026-10-05T13:00:00.000Z');
    await channelMessageRepository.upsertChannelReadStatus({ userId: viewer.id, channelId: channel.id, readAt: new Date('2026-10-05T08:00:00.000Z') });
    await channelMessageRepository.upsertChannelReadStatus({ userId: viewer.id, channelId: channel.id, readAt: later });

    const result = await channelMessageRepository.findChannelLastReadAt({ userId: viewer.id, channelId: channel.id });

    expect(result?.toISOString()).toBe(later.toISOString());
  });
});
