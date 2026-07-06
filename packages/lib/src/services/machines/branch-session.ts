/**
 * Branch-terminal session identity (pure).
 *
 * A branch-terminal is its OWN Sprite — never the owning Machine's, and never
 * shared with any other branch of the same Project. `deriveBranchSessionKey`
 * mirrors `deriveTerminalSessionKey` (services/sandbox/terminal-session-manager.ts):
 * an opaque HMAC name, namespaced so a (tenant, machine, project, branch)
 * tuple ALWAYS resolves to the same Sprite name — and, critically, two
 * different branch names always resolve to two DIFFERENT Sprite names, so
 * `MachineHost.provision` (which auto-resumes "same name, same filesystem")
 * can never accidentally hand two branches the same underlying Sprite.
 */

import { createHmac } from 'crypto';

export interface BranchSessionKeyInput {
  tenantId: string;
  terminalId: string;
  projectName: string;
  branchName: string;
  secret: string;
}

const NAMESPACE_VERSION = 'branch-session:v1';

export function deriveBranchSessionKey({
  tenantId,
  terminalId,
  projectName,
  branchName,
  secret,
}: BranchSessionKeyInput): string {
  if (secret.length === 0) {
    throw new Error('deriveBranchSessionKey requires a non-empty secret');
  }
  const payload = [NAMESPACE_VERSION, tenantId, terminalId, projectName, branchName].join('\0');
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-brn-${digest}`;
}

const MAX_BRANCH_NAME_LENGTH = 200;

// Mirrors `git check-ref-format --branch` intent without shelling out: the
// allowed charset already excludes whitespace/control chars and
// `~^:?*[\` — the remaining checks below rule out `..`, doubled `/`, a path
// segment starting with `.`, and a `.lock` suffix. Conservative on purpose —
// this becomes both a Sprite name component and a literal `git checkout -b`
// argument (never shell-interpreted, but still worth confining tightly).
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const FORBIDDEN_SEGMENT_RE = /(^|\/)\.|\.\.|\/{2,}|\.lock$/;

export function isValidBranchName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_BRANCH_NAME_LENGTH) {
    return false;
  }
  if (name.endsWith('/') || name.endsWith('.')) return false;
  if (!BRANCH_NAME_RE.test(name)) return false;
  if (FORBIDDEN_SEGMENT_RE.test(name)) return false;
  return true;
}
