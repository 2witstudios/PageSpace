import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { getAccountAuthority } from '@/lib/agent-accounts/account-authority-client';
import { actorFromAuth } from '@/lib/auth/request-actor';
import { codeChallengeOf, codeVerifierFor, createEnrollmentState, ENROLLMENT_COOKIE, ENROLLMENT_TTL_MS, googleAuthorizeUrl, googleRedirectUri } from '@/lib/agent-accounts/google-enrollment-flow';
import { GOOGLE_SERVICE_IDS } from '@pagespace/lib/agent-accounts/oauth/google-enrollment';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const startBody = z
  .object({
    owner: z.discriminatedUnion('kind', [z.object({ kind: z.literal('user') }).strict(), z.object({ kind: z.literal('agent_page'), agentPageId: z.string().min(1).max(64) }).strict()]),
    name: z.string().min(1).max(100),
    services: z.array(z.enum(GOOGLE_SERVICE_IDS as [string, ...string[]])).min(1).max(10),
    ownership: z.enum(['dedicated', 'personal']),
    acknowledged: z.boolean(),
    autoApproveReads: z.boolean(),
    returnTo: z.string().min(1).max(512).regex(/^\/(?!\/)/),
  })
  .strict();

const REFUSAL_STATUS: Readonly<Record<string, number>> = { forbidden: 403, owner_not_found: 404 };

/**
 * POST /api/agent-accounts/oauth/google/start
 * Begin connecting a Google account to an agent (or to your global assistant). Checks you may, then answers
 * the Google consent URL to send the browser to; Google returns it to the callback with a one-time code
 * that the credential plane — never this server — exchanges for tokens.
 */
export async function POST(request: Request) {
  if (isOnPrem()) return NextResponse.json({ error: 'Not available' }, { status: 404 });
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const authority = getAccountAuthority();
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.OAUTH_STATE_SECRET;
  if (authority === null || !clientId || !secret) return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  const parsed = startBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const { owner, returnTo, ...input } = parsed.data;
  try {
    const prepared = await authority.prepareOAuthEnrollment({ actor: actorFromAuth(auth), owner, input });
    if (!prepared.ok) return NextResponse.json({ error: prepared.reason }, { status: REFUSAL_STATUS[prepared.reason] ?? 400 });
    const { state, nonce } = createEnrollmentState({ secret, userId: auth.userId, owner, input, returnTo, now: Date.now() });
    const authorizeUrl = googleAuthorizeUrl({ clientId, redirectUri: googleRedirectUri(), scopes: prepared.requestedScopes, state, codeChallenge: codeChallengeOf(codeVerifierFor(secret, nonce)) });
    const response = NextResponse.json({ authorizeUrl });
    // Lax: sent on Google's top-level redirect back, never on a cross-site subrequest.
    response.cookies.set(ENROLLMENT_COOKIE, nonce, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: Math.floor(ENROLLMENT_TTL_MS / 1000) });
    return response;
  } catch (error) {
    loggers.api.error('Error starting a Google agent account connection', error as Error);
    return NextResponse.json({ error: 'Failed to start' }, { status: 500 });
  }
}
