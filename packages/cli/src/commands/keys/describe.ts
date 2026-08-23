/**
 * `pagespace keys describe` — what the credential this invocation would use
 * actually is, and what it is actually allowed to do.
 *
 * The question `keys list` cannot answer for a key, and the one an agent needs
 * most: a key minted `--role member` reads fine and fails every write with
 * "Write permission required.", and until this command the only way to learn
 * that was to attempt writes and read the refusals (issue #2470).
 *
 * Two properties make this the right shape:
 *
 * - It describes ONE credential — the one calling — so it accepts the `mcp_`
 *   class the key-management routes refuse, without letting a key learn
 *   anything about the other keys its owner holds.
 * - The permissions come from the server's own resolver
 *   (`GET /api/auth/key` → `getPrincipalDriveAccessLevel`), not from reading
 *   the role string locally. A local reading would be a second permission model,
 *   and the moment it drifted this command would confidently tell an agent it
 *   may write while the write path disagreed.
 *
 * Deliberately no identity: a key never yields the person behind it (see
 * `auth/probe-drives.ts`), so there is no name or email here to print.
 *
 * Two questions, kept apart on purpose. The per-drive line answers the
 * DRIVE-level one — creating a top-level page, sharing or deleting the drive —
 * where any membership at all grants edit. A page can be strictly narrower: a
 * plain MEMBER may create at the drive root and be view-only on a document
 * inside it, which is exactly the shape #2470 was filed about. Printing the
 * drive line as a bare "can: view edit" would reproduce that confusion from the
 * other side, so it is labelled for what it covers and `--page <pageId>`
 * resolves the page a caller is actually about to write to.
 *
 * The one `keys` verb that is NOT in `run.ts`'s `AUTH_EXEMPT_HANDLERS`, on
 * purpose. The rest of the family manages keys and so wants the ambient login;
 * this one reports on whatever credential the CONTENT commands on this machine
 * would authenticate as, which means it must resolve the same way they do —
 * including this machine's active key (`pagespace keys use`), which the exempt
 * verbs deliberately never see.
 */
import { describeSelfKey } from '@pagespace/sdk';
import type { z } from 'zod';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../exit-codes.js';
import type { CommandHandler } from '../../router/router.js';

type KeyDescription = z.infer<typeof describeSelfKey.outputSchema>;
type DescribedScope = KeyDescription['driveScopes'][number];

const CREDENTIAL_LABELS: Record<KeyDescription['credential']['type'], string> = {
  mcp: 'access key',
  oauth: 'personal login',
  session: 'signed-in session',
};

/**
 * The four flags as a readable line. `canDelete` is included even though it is
 * false for every non-admin grant: a reader checking "may this key delete?"
 * needs to see the answer, not to infer it from an omission.
 */
function formatPermissions(permissions: DescribedScope['permissions']): string {
  const granted = (['canView', 'canEdit', 'canShare', 'canDelete'] as const).filter((flag) => permissions[flag]);
  if (granted.length === 0) return 'nothing (no access here)';
  return granted.map((flag) => flag.slice(3).toLowerCase()).join(' ');
}

/** How the role was arrived at, spelled out — `role: null` means inherit, not "unset". */
function formatGrant(scope: DescribedScope): string {
  if (scope.roleSource === 'custom') return `custom role "${scope.customRoleName ?? scope.customRoleId ?? 'unknown'}"`;
  if (scope.roleSource === 'inherited') return 'inherits your own access in this drive';
  return `role ${(scope.role ?? 'unknown').toLowerCase()}`;
}

export const KEYS_DESCRIBE_USAGE = 'Usage: pagespace keys describe [--page <pageId>]';

export type ParseKeysDescribeArgsResult =
  | { readonly ok: true; readonly pageId?: string }
  | { readonly ok: false; readonly message: string };

/** Pure: no I/O. */
export function parseKeysDescribeArgs(rest: readonly string[]): ParseKeysDescribeArgsResult {
  if (rest.length === 0) return { ok: true };
  if (rest.length !== 2 || rest[0] !== '--page') return { ok: false, message: KEYS_DESCRIBE_USAGE };
  const pageId = rest[1];
  if (pageId.length === 0 || pageId.startsWith('-')) return { ok: false, message: KEYS_DESCRIBE_USAGE };
  return { ok: true, pageId };
}

/** Pure: no I/O. */
export function renderKeyDescription(description: KeyDescription): string {
  const { credential, driveScopes } = description;
  const lines: string[] = [];

  lines.push(`Credential: ${CREDENTIAL_LABELS[credential.type]}${credential.name === null ? '' : ` "${credential.name}"`}`);
  if (credential.tokenPrefix !== null) {
    lines.push(`Prefix:     ${credential.tokenPrefix}…`);
  }
  if (credential.createdAt !== null) {
    lines.push(`Created:    ${credential.createdAt}`);
    lines.push(`Last used:  ${credential.lastUsed ?? 'never'}`);
  }
  lines.push(`Scope:      ${credential.scoped ? `${driveScopes.length} drive(s)` : 'unrestricted (every drive you can reach)'}`);

  lines.push('');
  if (driveScopes.length === 0) {
    // Reached by a key whose scoped drives were all deleted, and by a
    // management-only credential. Both are real states, and both need saying
    // out loud — a bare empty list reads as a display bug.
    lines.push('No drives are reachable with this credential.');
  }
  for (const scope of driveScopes) {
    lines.push(`${scope.name}  (${scope.id})`);
    lines.push(`  granted:      ${formatGrant(scope)}`);
    // Labelled, not bare: this is the drive-as-root-node answer, and an
    // unqualified "can: view edit" would be read as "I can edit the pages".
    lines.push(`  on the drive: ${formatPermissions(scope.permissions)}`);
  }

  // Printed even with no reachable drives — `--page` was still asked, and a
  // silent omission would read as the flag having been ignored.
  lines.push('');
  lines.push(
    description.page === null
      ? 'A page inside a drive can be narrower than the drive itself. Check one with "pagespace keys describe --page <pageId>".'
      : `Page ${description.page.id}: ${
          description.page.permissions === null
            ? 'out of reach (another drive, or private to someone else)'
            : formatPermissions(description.page.permissions)
        }`,
  );
  return `${lines.join('\n')}\n`;
}

export const keysDescribeHandler: CommandHandler = async (ctx, intent) => {
  const parsed = parseKeysDescribeArgs(intent.args);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  let description: KeyDescription;
  try {
    description = await ctx.sdk.invoke(describeSelfKey, parsed.pageId === undefined ? {} : { pageId: parsed.pageId });
  } catch (error) {
    ctx.stderr.write(`Failed to describe this credential: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_RUNTIME_ERROR;
  }

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(description)}\n`);
    return EXIT_SUCCESS;
  }

  ctx.stdout.write(renderKeyDescription(description));
  return EXIT_SUCCESS;
};
