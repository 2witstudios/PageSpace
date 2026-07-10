import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authRepository } from '@/lib/repositories/auth-repository';
import { isExternalHttpUrl } from '@/lib/auth/google-avatar';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

// Session (browser) and OAuth (CLI `pagespace login` identity confirmation,
// ADR 0003) both resolve identity the same way; `mcp_*` tokens are scoped
// agent credentials with no single "current user" concept and stay excluded
// — a scoped token is its own drive-member principal (ADR 0002 Decision 2),
// and `auth.userId` here would still resolve to the personal owner behind
// it, handing that owner's email/name/image to whatever holds the token.
// `pagespace keys create`'s post-mint `confirmIdentity` call (loopback-flow.ts)
// also authenticates with the freshly-minted mcp_* token and so no longer
// resolves — that call's result isn't even read by `keys create` (only
// `login`/`login-device`/`whoami` render `identity`), and its failure is
// already caught and silently absorbed (loopback-flow.ts), so this is a
// no-op UX-wise, not a functional regression.
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
