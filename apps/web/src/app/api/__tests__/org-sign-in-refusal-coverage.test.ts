/**
 * Guard (D-OW-45, SEC-2/SEC-3): a route that refuses org content after an access check must name an org sign-in
 * denial, so the person is asked to sign in again (or with a passkey) instead of reading a bare 403/404. A route
 * qualifies when it calls an access function and answers 403/404; it then either routes its refusals through
 * `deniedResponse` / `explainSignInRefusal`, or sits in EXEMPT with the reason its refusals are not access decisions.
 *
 * Limits, stated: a source scan per file. Which refusal in a file is wrapped is proven by the route tests and the
 * real-Postgres sign-in suites; this keeps a new route from forgetting the code altogether.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(__dirname, '../..');

const ACCESS = /\b(canPrincipal\w+|isPrincipal\w+|getPrincipal\w+|canUser\w+Page|getUserAccessLevel|getUserDriveAccess|isUserDriveMember|isDriveOwnerOrAdmin|getUserDrivePermissions|checkDriveAccess\w*|getDriveAccess\w*|getDriveWithAccess|loadDriveRelationship|loadDriveLeadAuthority|canUserAccessFile|canAccessConversation|checkSessionAccess|canActor\w+)\(/;
const REFUSES = /status:\s*40[34]/;
const NAMES_DENIAL = /\b(deniedResponse|explainSignInRefusal)\(/;

const AGENT_SESSION_FAMILY =
  'agent-session family answers every refusal as one 404 by design, so a session id is never an existence oracle (workspace-unavailable-response, review #2261/5)';

const EXEMPT: Record<string, string> = {
  'api/agent-workspaces/route.ts': AGENT_SESSION_FAMILY,
  'api/agent-workspaces/[workspaceId]/route.ts': AGENT_SESSION_FAMILY,
  'api/agent-workspaces/[workspaceId]/files/route.ts': AGENT_SESSION_FAMILY,
  'api/agent-workspaces/[workspaceId]/shells/route.ts': AGENT_SESSION_FAMILY,
  'api/agent-workspaces/[workspaceId]/diff/route.ts': AGENT_SESSION_FAMILY,
  'api/agent-workspaces/[workspaceId]/conversations/route.ts': AGENT_SESSION_FAMILY,
  'api/agent-workspaces/[workspaceId]/conversations/[conversationId]/route.ts': AGENT_SESSION_FAMILY,
  'api/agent-workspaces/[workspaceId]/conversations/[conversationId]/claim/route.ts': AGENT_SESSION_FAMILY,
  'api/agent-workspaces/[workspaceId]/conversations/[conversationId]/reopen/route.ts': AGENT_SESSION_FAMILY,
  'api/agent-workspaces/[workspaceId]/exec/route.ts': AGENT_SESSION_FAMILY,
  'api/agent-workspaces/[workspaceId]/nodes/route.ts': AGENT_SESSION_FAMILY,
  'api/agent-workspaces/[workspaceId]/git-blob/route.ts': AGENT_SESSION_FAMILY,
  'api/ai/conversations/[conversationId]/plan/route.ts': 'refusals are conversation not-found/ownership by design (no existence oracle)',
  'api/user/integrations/callback/route.ts': 'only refusal is the on-prem feature gate; the drive check redirects with an error',
  'api/storage/info/route.ts': 'only refusal is the app-admin reconcile gate',
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (entry === 'route.ts' || entry === 'page.tsx') out.push(full);
  }
  return out;
}

const refusing = sources(APP)
  .map((file) => ({ file: relative(APP, file), text: readFileSync(file, 'utf8') }))
  .filter(({ text }) => ACCESS.test(text) && REFUSES.test(text));

describe('org sign-in refusal coverage (D-OW-45)', () => {
  it('SEC-2 (partial) every route that refuses after an access check names an org sign-in denial', () => {
    const silent = refusing.filter(({ file, text }) => !NAMES_DENIAL.test(text) && !(file in EXEMPT)).map(({ file }) => file);
    expect(silent).toEqual([]);
  });

  it('SEC-2 (partial) the exemption list stays honest: every entry is a refusing route that names no denial', () => {
    const byFile = new Map(refusing.map(({ file, text }) => [file, text]));
    const stale = Object.keys(EXEMPT).filter((file) => !byFile.has(file) || NAMES_DENIAL.test(byFile.get(file) ?? ''));
    expect(stale).toEqual([]);
  });
});
