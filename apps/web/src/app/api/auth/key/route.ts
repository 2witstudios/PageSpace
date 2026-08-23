/**
 * `GET /api/auth/key` — what the credential making this call actually is, and
 * what it is actually allowed to do.
 *
 * The gap this closes (issue #2470): a key minted `--role member` reads fine
 * and fails every write with "Write permission required.", and nothing —
 * not at mint time, not afterwards — could be asked what the key could do.
 * The only way to find out was to attempt writes and read the refusals.
 *
 * Why this is a separate route from the `mcp-tokens` family rather than a
 * relaxation of it: those routes manage the whole set of keys a person holds,
 * so they admit only a full-user credential (see `mcp-tokens/scope-guard.ts` —
 * a drive-scoped OAuth token is refused there for exactly this reason, and an
 * `mcp_` token never reaches them at all). This route answers only about the
 * credential presenting itself, which is a question that credential is always
 * entitled to ask, so it accepts every class including `mcp_`. A key describes
 * ITSELF; it never describes another key.
 *
 * Nothing here is new information: the drive list is what `drives.list` already
 * returns to this same credential, and the effective permissions are the
 * decision every content route was already going to make on the next request.
 * The one thing deliberately withheld is the owning USER — no name, no email,
 * no user id. `/api/auth/me` refuses `mcp_` tokens precisely so that holding a
 * scoped key does not hand over the person behind it
 * (`packages/cli/src/auth/probe-drives.ts`), and this route must not become the
 * back door to the same thing.
 *
 * Every permission below comes from `getPrincipalDriveAccessLevel` — the same
 * resolver chain (`getAppDriveAccessLevel` / `getScopedDriveAccessLevel` /
 * `getUserAccessLevel`) that authorizes the real request. No second reading of
 * the role vocabulary lives in this file; if it did, this route could tell an
 * agent it may write while the write path disagreed.
 *
 * Drive-level and page-level are genuinely different answers, so both are
 * available rather than one standing in for the other. `driveScopes[].permissions`
 * is the drive-as-root-node question — creating a top-level page, sharing or
 * deleting the drive — where any membership grants edit. A PAGE goes through
 * `getPrincipalAccessLevel` and can be strictly narrower: a plain MEMBER may
 * create at the drive root and still be view-only on a document inside it,
 * which is precisely the "reads fine, every write fails" report behind #2470.
 * Reporting only the drive level would reproduce that confusion from the other
 * side, so `?pageId=` resolves the page the caller actually cares about.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, type AuthResult } from '@/lib/auth';
import {
  getPrincipalAccessLevel,
  getPrincipalDriveAccessLevel,
  getPrincipalDriveIds,
  getPrincipalDriveMembership,
  isDriveScopedPrincipal,
} from '@/lib/auth/principal-permissions';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { getRoleById } from '@pagespace/lib/services/drive-role-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';

// Every class the SDK and the first-party surfaces can present. `mcp` is the
// point of the route; `oauth` and `session` are included so one command
// (`pagespace keys describe`) answers the same question whichever credential
// this machine happens to be using. No CSRF: this is a read, and Bearer auth
// skips CSRF anyway (`authenticateRequestWithOptions`).
const AUTH_OPTIONS_READ = { allow: ['mcp', 'oauth', 'session'] as const, requireCSRF: false };

/**
 * `role: null` is not "no role" — for a scoped credential it is INHERIT (the key
 * resolves with its owner's access in that drive), and for a user principal it
 * cannot occur at all, since `getPrincipalDriveMembership` returns null rather
 * than a roleless membership. Naming the three cases explicitly keeps a reader
 * of the output from having to know that.
 */
function describeRoleSource(
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | null,
  customRoleId: string | null,
): 'explicit' | 'custom' | 'inherited' {
  if (customRoleId !== null) return 'custom';
  return role === null ? 'inherited' : 'explicit';
}

/**
 * The three classes a request can actually arrive as here. `AuthResult` has a
 * fourth variant, `service`, which no route's `allow` list can name and
 * `authenticateRequestWithOptions` never constructs (see `AllowedTokenType`) —
 * it is excluded at the door below rather than given a branch, so a future
 * fifth variant cannot quietly inherit a description written for these three.
 */
type PresentedAuth = Extract<AuthResult, { tokenType: 'mcp' | 'oauth' | 'session' }>;

/** The `credential` block. Only an `mcp_` credential has a key row to name. */
async function describeCredential(auth: PresentedAuth) {
  const base = {
    type: auth.tokenType,
    scoped: isDriveScopedPrincipal(auth),
    id: null as string | null,
    name: null as string | null,
    tokenPrefix: null as string | null,
    createdAt: null as string | null,
    lastUsed: null as string | null,
  };

  if (auth.tokenType !== 'mcp') return base;

  const token = await sessionRepository.findMcpTokenSelfById(auth.tokenId, auth.userId);
  if (!token) return base;

  return {
    ...base,
    id: token.id,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    createdAt: token.createdAt.toISOString(),
    lastUsed: token.lastUsed?.toISOString() ?? null,
  };
}

export async function GET(req: NextRequest) {
  const authResult = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(authResult)) return authResult.error;
  if (authResult.tokenType === 'service') {
    // Unreachable by construction (see PresentedAuth) — refused rather than
    // described, so the narrowing below is a fact and not an assertion.
    return NextResponse.json({ error: 'Unsupported credential type' }, { status: 400 });
  }
  const auth: PresentedAuth = authResult;

  try {
    const credential = await describeCredential(auth);

    // The principal's own drive universe, not its owner's: for a scoped
    // credential this is exactly its `mcp_token_drives` rows.
    const driveIds = await getPrincipalDriveIds(auth);
    const driveNames = new Map(
      (driveIds.length > 0 ? await sessionRepository.findDrivesByIds(driveIds) : []).map((drive) => [
        drive.id,
        drive.name,
      ]),
    );

    const driveScopes = [];
    for (const driveId of driveIds) {
      const permissions = await getPrincipalDriveAccessLevel(auth, driveId);
      const membership = await getPrincipalDriveMembership(auth, driveId);
      const role = membership?.role ?? null;
      const customRoleId = membership?.customRoleId ?? null;
      const customRole = customRoleId ? await getRoleById(driveId, customRoleId) : null;

      driveScopes.push({
        id: driveId,
        name: driveNames.get(driveId) ?? driveId,
        role,
        customRoleId,
        customRoleName: customRole?.name ?? null,
        roleSource: describeRoleSource(role, customRoleId),
        // A scope whose drive resolves to no access at all — a dangling inherit
        // row whose owner lost the drive, a custom role deleted out from under
        // the key — is reported as an all-false entry rather than dropped.
        // "You hold a grant here that currently gets you nothing" is the honest
        // answer; omitting the row would read as never having had access.
        permissions: permissions ?? { canView: false, canEdit: false, canShare: false, canDelete: false },
      });
    }

    // Only when asked. `permissions: null` (out of reach) is preserved rather
    // than flattened to all-false: "this page is not yours to see" and "you may
    // do nothing with this page" are different answers, and an agent choosing
    // where to write needs to tell them apart.
    const pageId = req.nextUrl.searchParams.get('pageId');
    const page = pageId === null ? null : { id: pageId, permissions: await getPrincipalAccessLevel(auth, pageId) };

    auditRequest(req, {
      eventType: 'data.read',
      userId: auth.userId,
      resourceType: 'credential_self_description',
      resourceId: credential.id ?? auth.tokenType,
    });

    return NextResponse.json({ credential, driveScopes, page });
  } catch (error) {
    loggers.auth.error('Error describing credential:', error as Error);
    return NextResponse.json({ error: 'Failed to describe credential' }, { status: 500 });
  }
}
