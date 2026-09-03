import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  hasCompletedOnboarding,
  markOnboardingComplete,
} from '@pagespace/lib/onboarding/onboarding-state';
import { recordOnboardingContext } from '@pagespace/lib/onboarding/onboarding-memory';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * GET /api/onboarding — should the first-run flow be shown?
 *
 * Deliberately a distinct endpoint rather than a field on display-preferences:
 * that surface is a settings-facing store of display toggles whose GET returns a
 * fixed shape, and onboarding completion is user lifecycle state. Keeping them
 * apart also means the client can distinguish "still loading" from "not
 * onboarded" — folding it into a hook that defaults every flag to `false` while
 * loading would flash the modal at every returning user on every page load.
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const completed = await hasCompletedOnboarding(auth.userId);
    return NextResponse.json({ needsOnboarding: !completed });
  } catch (error) {
    loggers.api.error('Failed to read onboarding state', { error });
    return NextResponse.json({ error: 'Failed to read onboarding state' }, { status: 500 });
  }
}

/**
 * POST /api/onboarding — record completion, and remember what they told us.
 *
 * Completion is recorded even when the memory write fails or is skipped: the
 * user has finished the flow either way, and re-showing it because a secondary
 * write failed would be a worse bug than a missing memory line.
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const body = await request.json().catch(() => ({}));
    const scaleLabel = typeof body?.scaleLabel === 'string' ? body.scaleLabel : '';
    const firstRequest = typeof body?.firstRequest === 'string' ? body.firstRequest : '';

    await markOnboardingComplete(auth.userId);

    let remembered = false;
    if (scaleLabel && firstRequest.trim()) {
      try {
        const result = await recordOnboardingContext(auth.userId, { scaleLabel, firstRequest });
        remembered = result.written;
      } catch (error) {
        // Non-fatal by design — see the note above.
        loggers.api.error('Failed to record onboarding context to memory', { error });
      }
    }

    return NextResponse.json({ ok: true, remembered });
  } catch (error) {
    loggers.api.error('Failed to complete onboarding', { error });
    return NextResponse.json({ error: 'Failed to complete onboarding' }, { status: 500 });
  }
}
