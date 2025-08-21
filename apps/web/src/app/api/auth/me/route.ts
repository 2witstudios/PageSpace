import { users, db, eq } from '@pagespace/db';
import { requireAuth, isAuthError } from '@/lib/auth-helpers';

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const user = await db.query.users.findFirst({
    where: eq(users.id, auth.userId),
    columns: {
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
      provider: true,
      googleId: true,
    },
  });

  if (!user) {
    console.error(`[AUTH] User not found for userId: ${auth.userId}`);
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  console.log(`[AUTH] User profile loaded: ${user.email} (provider: ${user.provider}, id: ${user.id})`);

  return Response.json({
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    role: user.role,
  });
}