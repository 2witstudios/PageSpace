import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authRepository } from '@/lib/repositories/auth-repository';
import { isExternalHttpUrl } from '@/lib/auth/google-avatar';

// Session (browser) and OAuth (CLI `pagespace login` identity confirmation,
// ADR 0003) both resolve identity the same way; `mcp_*` tokens are scoped
// agent credentials with no single "current user" concept and stay excluded.
const AUTH_OPTIONS = { allow: ['session', 'oauth'] as const, requireCSRF: false };

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const user = await authRepository.findUserById(auth.userId);

  if (!user) {
    console.error(`[AUTH] User not found for userId: ${auth.userId}`);
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  // Only log in debug mode to reduce auth spam
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
    console.log(`[AUTH] User profile loaded: ${user.email} (provider: ${user.provider}, id: ${user.id})`);
  }

  auditRequest(req, { eventType: 'data.read', userId: auth.userId, resourceType: 'user_profile', resourceId: auth.userId });

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
