import { NextResponse } from 'next/server';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';

/**
 * Whether dev-server preview is turned on for this deployment —
 * `GET /api/dev-preview/capability`.
 *
 * The preview pane (the next task) must not RENDER at all on a deployment
 * where `DEV_PREVIEW_ENABLED` is unset or no `DEV_PREVIEW_APEX` is
 * configured — the default everywhere. Same "expose a capability, not the
 * flag's mechanics" shape as `app-hosting/capability`: server-derived, no
 * `NEXT_PUBLIC_*` leak, no auth (a boolean about the deployment, not about
 * any user's data).
 */
export async function GET() {
  return NextResponse.json({ enabled: isDevPreviewConfigured() });
}
