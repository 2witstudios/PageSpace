/**
 * Branch-terminal session identity (pure).
 *
 * A branch-terminal is its OWN Sprite — never the owning Machine's, and never
 * shared with any other branch of the same Project. `deriveBranchSessionKey`
 * mirrors `deriveMachineSessionKey` (services/sandbox/machine-session-manager.ts):
 * an opaque HMAC name, namespaced so a (tenant, machine, project, branch)
 * tuple ALWAYS resolves to the same Sprite name — and, critically, two
 * different branch names always resolve to two DIFFERENT Sprite names, so
 * `MachineHost.provision` (which auto-resumes "same name, same filesystem")
 * can never accidentally hand two branches the same underlying Sprite.
 *
 * `isValidBranchName`/`normalizeBranchName` themselves live in `./branch-name`
 * (re-exported here for existing call sites) — that module has zero
 * node-builtin imports, so a client component can import it directly for a
 * live-typing name preview without dragging this file's `crypto` dependency
 * into the browser bundle.
 */

import { createHmac } from 'crypto';

export { isValidBranchName, normalizeBranchName } from './branch-name';

export interface BranchSessionKeyInput {
  tenantId: string;
  machineId: string;
  projectName: string;
  branchName: string;
  secret: string;
}

const NAMESPACE_VERSION = 'branch-session:v1';

export function deriveBranchSessionKey({
  tenantId,
  machineId,
  projectName,
  branchName,
  secret,
}: BranchSessionKeyInput): string {
  if (secret.length === 0) {
    throw new Error('deriveBranchSessionKey requires a non-empty secret');
  }
  const payload = [NAMESPACE_VERSION, tenantId, machineId, projectName, branchName].join('\0');
  // codeql[js/insufficient-password-hash] not a password hash — a keyed HMAC over SANDBOX_SESSION_SECRET (a >=32-char server secret, never user input) deriving a deterministic Sprite-name pseudonym, same as machine-session-manager.ts's deriveMachineSessionKey
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-brn-${digest}`;
}
