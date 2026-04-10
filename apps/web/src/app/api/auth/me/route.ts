import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { loggers, securityAudit } from '@pagespace/lib/server';
import { authRepository } from '@/lib/repositories/auth-repository';
import { isExternalHttpUrl } from '@/lib/auth/google-avatar';

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const user = await authRepository.findUserById(auth.userId);

  if (!user) {
    console.error(`[AUTH] User not found for userId: ${auth.userId}`);
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  // Only log in debug mode to reduce auth spam
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
    console.log(`[AUTH] User profile loaded: ${user.email} (provider: ${user.provider}, id: ${user.id})`);
  }

  securityAudit.logDataAccess(auth.userId, 'read', 'user_profile', auth.userId).catch((error) => {
    loggers.security.warn('[AuthMe] audit logDataAccess failed', { error: error instanceof Error ? error.message : String(error), userId: auth.userId });
  });

  const safeImage = isExternalHttpUrl(user.image) ? null : user.image;

  return Response.json({
    id: user.id,
    name: user.name,
    email: user.email,
    image: safeImage,
    role: user.role,
    emailVerified: user.emailVerified,
  });
}
