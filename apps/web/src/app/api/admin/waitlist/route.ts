import { db } from '@pagespace/db/db';
import { waitlistEntries } from '@pagespace/db/schema/waitlist';
import { count, desc } from '@pagespace/db/operators';
import { withAdminAuth } from '@/lib/auth';

export const GET = withAdminAuth(async () => {
  const [entries, [{ total }]] = await Promise.all([
    db.select().from(waitlistEntries).orderBy(desc(waitlistEntries.createdAt)),
    db.select({ total: count() }).from(waitlistEntries),
  ]);

  return Response.json({ entries, total });
});
