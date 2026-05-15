import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { count } from '@pagespace/db/operators';

const MAX_USERS = parseInt(process.env.MAX_USERS ?? '0', 10);

export const isUserLimitEnabled = () => MAX_USERS > 0;

export async function isAtUserLimit(): Promise<boolean> {
  if (!isUserLimitEnabled()) return false;
  const [{ value }] = await db.select({ value: count() }).from(users);
  return value >= MAX_USERS;
}
