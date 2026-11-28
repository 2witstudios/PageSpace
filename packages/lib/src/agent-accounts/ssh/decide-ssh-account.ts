/**
 * `decideSshAccount` — what a person asked an SSH account to be, as a verdict
 * (slice 5). Pure. One pinned host (`normalizeSshTarget`), one login user, the
 * host key the person CONFIRMED (the plane reports it; a person compares it
 * with the server's own `ssh-keygen -l`), and an optional standing policy:
 * "run commands without asking", bounded like any other (uses per hour) —
 * every command is `unknown/ssh.exec`, so asking is the default.
 */
import type { AccountAcknowledgment } from '@pagespace/db/schema/agent-accounts';
import type { AccountApprovalPolicy } from '../approval';
import type { CanonicalOrigin } from '../canonical-request';
import type { UserId } from '../grant';
import type { LoginOwnership } from '../decide-acknowledgment';
import { decideAcknowledgment } from '../decide-acknowledgment';
import { MAX_ACCOUNT_NAME_LENGTH } from '../decide-account-creation';
import { normalizeSshTarget, SSH_OPERATION } from './ssh-command';

export const SSH_POLICY_LIMITS = { maxUsesPerHour: 30, maxBytesOut: 2 * 1024 * 1024, maxConcurrent: 2 } as const;
const USERNAME_RE = /^[a-z_][a-z0-9_.-]{0,63}$/i;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

export type SshAccountInput = {
  readonly name: string;
  readonly host: string;
  readonly port: number | null;
  readonly username: string;
  readonly hostKeySha256: string;
  readonly ownership: LoginOwnership;
  readonly acknowledged: boolean;
  /** Exactly `true` = "let the agent run commands without asking" (up to the hourly limit). */
  readonly runWithoutAsking: boolean;
};

export type SshAccountDraft = {
  readonly kind: 'ssh_key';
  readonly name: string;
  readonly allowedOrigins: readonly CanonicalOrigin[];
  readonly acknowledgment: AccountAcknowledgment;
  readonly approvalPolicy: AccountApprovalPolicy | null;
  readonly username: string;
  readonly hostKeySha256: string;
};

export type SshAccountVerdict =
  | { readonly ok: true; readonly draft: SshAccountDraft }
  | { readonly ok: false; readonly reason: 'name_invalid' | 'host_invalid' | 'port_invalid' | 'username_invalid' | 'host_key_invalid' | 'acknowledgment_required' };

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

/** The standing policy over SSH commands to one target. */
export function sshPolicyFor({ target, maxUsesPerHour, until, approver }: { readonly target: CanonicalOrigin; readonly maxUsesPerHour: number; readonly until: number | null; readonly approver: UserId }): AccountApprovalPolicy {
  return { scope: { origins: [target], operations: [{ ...SSH_OPERATION }], resources: [] }, trigger: 'irreversible_only', duration: until === null ? null : { until }, limits: { ...SSH_POLICY_LIMITS, maxUsesPerHour }, approver };
}

export function decideSshAccount({ input, approver }: { readonly input: SshAccountInput; readonly approver: UserId }): SshAccountVerdict {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0 || name.length > MAX_ACCOUNT_NAME_LENGTH || CONTROL_CHAR_RE.test(name)) return { ok: false, reason: 'name_invalid' };
  const target = normalizeSshTarget({ host: input.host, port: input.port });
  if (!target.ok) return target;
  if (typeof input.username !== 'string' || !USERNAME_RE.test(input.username)) return { ok: false, reason: 'username_invalid' };
  if (typeof input.hostKeySha256 !== 'string' || !FINGERPRINT_RE.test(input.hostKeySha256)) return { ok: false, reason: 'host_key_invalid' };
  const acknowledgment = decideAcknowledgment({ kind: 'ssh_key', ownership: input.ownership, acknowledged: input.acknowledged });
  if (!acknowledgment.ok) return { ok: false, reason: 'acknowledgment_required' };
  return {
    ok: true,
    draft: {
      kind: 'ssh_key',
      name,
      allowedOrigins: [target.target],
      acknowledgment: acknowledgment.acknowledgment,
      approvalPolicy: input.runWithoutAsking === true ? sshPolicyFor({ target: target.target, maxUsesPerHour: SSH_POLICY_LIMITS.maxUsesPerHour, until: null, approver }) : null,
      username: input.username,
      hostKeySha256: input.hostKeySha256,
    },
  };
}
