import { NextResponse } from 'next/server';
import { isAppHostingEnabled } from '@pagespace/lib/services/app-hosting/app-hosting-env';

/**
 * Whether app hosting is turned on for this deployment — `GET /api/app-hosting/capability`.
 *
 * The publish surface must not RENDER at all on a deployment where
 * `APP_HOSTING_ENABLED` is unset (the default everywhere): a visible Publish
 * button whose click 404s is a worse experience than no button, and it makes a
 * dark feature look broken rather than absent. This is the one client-visible
 * read of the kill switch, following the same "expose a capability, not the
 * flag's mechanics" shape as `isCodeExecutionEnabled()`'s `codeExecutionEnabled`
 * field on other DTOs. No auth required — this is a boolean about the
 * deployment, not about any user's data.
 */
export async function GET() {
  return NextResponse.json({ enabled: isAppHostingEnabled() });
}
