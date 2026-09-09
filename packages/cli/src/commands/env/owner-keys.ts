/**
 * `pagespace env owner-keys <enrollmentId> [--json]` — what this machine will
 * accept as proof that YOU clicked (hardening B, leaf B1).
 *
 * The owner's passkeys are pinned at enrolment, beside the server signing key,
 * at the one moment the owner is provably at the keyboard. From then on a
 * chat approval must carry a WebAuthn assertion from one of these credentials,
 * over the exact request this machine froze — so this list is the answer to
 * "what, exactly, can make my computer run something?", and the owner is
 * entitled to read it without trusting a web page to tell them.
 *
 * READ ONLY, deliberately. There is no `owner-keys add`: a credential the
 * machine did not pin at enrolment cannot be added by PageSpace, by this CLI,
 * or by any frame (leaf B5) — that is precisely what makes the pinned set
 * worth anything. Registering a new passkey and wanting the machine to trust
 * it means re-enrolling the machine, which is a deliberate act at the keyboard
 * and is what this command says.
 *
 * Local only: reads the credential store, talks to nothing.
 */
import { createCredentialStore } from '../../credentials/store.js';
import type { CredentialStore } from '../../credentials/store.js';
import { machineProfileName } from '../../credentials/serialize.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../exit-codes.js';
import type { CommandHandler } from '../../router/router.js';
import { isEnrolledMachineCredential, resolveHostFor } from '../env.js';
import type { PinnedOwnerApproval } from '../../env-bridge/lib-core.js';

export interface EnvOwnerKeysHandlerDeps {
  readonly createCredentialStore: () => CredentialStore;
}

/** How a pinned credential is shown: the id, and a short prefix of the key so two entries are distinguishable. Never a private key — there is none here to leak, but the habit is the point. */
export function describePinnedCredential(credential: { credentialId: string; publicKeyCose: string }): string {
  return `${credential.credentialId}  (public key ${credential.publicKeyCose.slice(0, 16)}…)`;
}

export function renderOwnerKeys(enrollmentId: string, pinned: PinnedOwnerApproval | undefined): string {
  if (pinned === undefined) {
    return (
      `Enrollment ${enrollmentId} has NO pinned owner credentials.\n` +
      'This machine cannot verify that a human clicked, so it refuses approvals in the PageSpace chat and asks in the terminal instead.\n' +
      'To use chat approvals: register a passkey in PageSpace, then re-enrol this machine.\n'
    );
  }
  if (pinned.credentials.length === 0) {
    return (
      `Enrollment ${enrollmentId} pinned an EMPTY set of owner credentials (you had no passkey when you enrolled).\n` +
      `  relying party  ${pinned.rpId}\n` +
      `  origin         ${pinned.origin}\n` +
      'Approvals in the PageSpace chat are refused until you register a passkey and RE-ENROL this machine. A key can never be added to a pinned set afterwards — not by PageSpace, not by this CLI, not by any message on the bridge.\n'
    );
  }
  return (
    `Enrollment ${enrollmentId} will accept a chat approval signed by any of these ${pinned.credentials.length}:\n` +
    `  relying party  ${pinned.rpId}\n` +
    `  origin         ${pinned.origin}\n` +
    pinned.credentials.map((credential) => `  - ${describePinnedCredential(credential)}\n`).join('') +
    'Every one of them was pinned when you enrolled. Nothing can add to this list; re-enrol the machine to change it.\n'
  );
}

export function createEnvOwnerKeysHandler(deps: EnvOwnerKeysHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const [enrollmentId] = intent.args;
    if (!enrollmentId) {
      ctx.stderr.write('Usage: pagespace env owner-keys <enrollmentId> [--host <url>] [--json]\n');
      return EXIT_USAGE_ERROR;
    }
    const host = resolveHostFor(ctx, intent.flags);
    const credential = await deps.createCredentialStore().get(host, machineProfileName(enrollmentId));
    if (!isEnrolledMachineCredential(credential)) {
      ctx.stderr.write(`No machine credential for enrollment ${enrollmentId} on ${host}. Run "pagespace env enroll <enrollmentId> <code>" first.\n`);
      return EXIT_RUNTIME_ERROR;
    }
    const pinned = credential.ownerApproval;
    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify({ enrollmentId, host, ownerApproval: pinned ?? null, chatApprovalsAvailable: (pinned?.credentials.length ?? 0) > 0 })}\n`);
    } else {
      ctx.stdout.write(renderOwnerKeys(enrollmentId, pinned));
    }
    return EXIT_SUCCESS;
  };
}

export const envOwnerKeysHandler: CommandHandler = createEnvOwnerKeysHandler({ createCredentialStore: () => createCredentialStore() });
