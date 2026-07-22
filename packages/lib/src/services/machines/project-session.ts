/**
 * Promoted-project session identity (pure).
 *
 * A project starts as a checkout on the OWNING Machine's own Sprite and is
 * PROMOTED, on first project-scoped spawn, to its own isolated Sprite
 * (`machine-project-promotion.ts`). This derives the opaque HMAC name that
 * Sprite is provisioned under — the exact mirror of `deriveBranchSessionKey`
 * (`./branch-session.ts`) and `deriveMachineSessionKey`
 * (`../sandbox/machine-session-manager.ts`), with its OWN namespace version so
 * a (tenant, machine, project) tuple can never collide with a branch's or a
 * machine's key.
 *
 * Determinism is load-bearing twice over: `MachineHost.provision` auto-resumes
 * "same name, same filesystem", so re-deriving this key is what lets a promoted
 * project whose row write never landed (a half-promotion) recover the SAME
 * Sprite on the next attempt instead of orphaning it, and what lets a
 * re-provision of a vanished Sprite come back to the same identity.
 */

import { createHmac } from 'crypto';

export interface ProjectSessionKeyInput {
  tenantId: string;
  machineId: string;
  projectName: string;
  secret: string;
}

const NAMESPACE_VERSION = 'project-session:v1';

export function deriveProjectSessionKey({
  tenantId,
  machineId,
  projectName,
  secret,
}: ProjectSessionKeyInput): string {
  if (secret.length === 0) {
    throw new Error('deriveProjectSessionKey requires a non-empty secret');
  }
  const payload = [NAMESPACE_VERSION, tenantId, machineId, projectName].join('\0');
  // codeql[js/insufficient-password-hash] not a password hash — a keyed HMAC over SANDBOX_SESSION_SECRET (a >=32-char server secret, never user input) deriving a deterministic Sprite-name pseudonym, same as branch-session.ts's deriveBranchSessionKey
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-prj-${digest}`;
}
