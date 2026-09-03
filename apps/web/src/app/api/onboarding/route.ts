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
 * POST /api/onboarding — remember what they told us, then record completion.
 *
 * Order matters: completion is the irreversible step. See the note at the write
 * itself.
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    // Parsed directly rather than swallowed into `{}`: a malformed body used to
    // fall through and permanently mark onboarding complete while silently
    // discarding the context, leaving the user no way to retry the flow.
    const body = await request.json();
    const scaleLabel = typeof body?.scaleLabel === 'string' ? body.scaleLabel : '';
    const firstRequest = typeof body?.firstRequest === 'string' ? body.firstRequest : '';

    // Memory FIRST, completion second. Completion is the irreversible half: once
    // it is stamped the modal never returns, so if the order were reversed a
    // failed memory write would lose the user's answers for good — and the copy
    // promises "it remembers". Writing first means a failure here leaves the
    // flow available to try again.
    let remembered = false;
    if (scaleLabel && firstRequest.trim()) {
      const result = await recordOnboardingContext(auth.userId, { scaleLabel, firstRequest });
      remembered = result.written;
    }

    await markOnboardingComplete(auth.userId);

    return NextResponse.json({ ok: true, remembered });
  } catch (error) {
    loggers.api.error('Failed to complete onboarding', { error });
    return NextResponse.json({ error: 'Failed to complete onboarding' }, { status: 500 });
  }
}
