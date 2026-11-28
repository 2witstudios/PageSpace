/**
 * `decideSshResult` — what one SSH command's transport outcome means for the
 * audit chain and for the caller (slice 5). Pure.
 *
 * - exited: `executed` with the exit code; the caller gets the output, with
 *   the account's key material scrubbed, decoded as UTF-8.
 * - failed before anything ran (`sent: false`): `upstream_failed`; the caller
 *   learns which — a CHANGED host key is named, because a person must decide
 *   whether to trust the new one, and a refused key means the public key is
 *   not installed yet.
 * - anything that may have run (timeout after connecting): `unknown`, never
 *   "failed" — the command may have had effects.
 * An outcome the audit chain did not record is never reported as success.
 */
import type { AuditedExecution, OperationOutcome } from '../audit-gate-executor';
import type { SshExecOutcome } from './ssh-client';
import { redactKnownValues } from '../redact-known-values';

export type SshCommandOutput = {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly redacted: boolean;
};

export type SshExecutionResult =
  | { readonly ok: true; readonly output: SshCommandOutput }
  | {
      readonly ok: false;
      readonly reason: 'refused' | 'host_unreachable' | 'host_key_changed' | 'key_not_accepted' | 'outcome_unknown' | 'outcome_unrecorded' | 'audit_unavailable';
    };

export function sshAuditOutcome(outcome: SshExecOutcome): OperationOutcome {
  if (outcome.kind === 'exited') return { kind: 'executed', upstreamStatus: outcome.exitCode };
  return outcome.sent ? { kind: 'unknown' } : { kind: 'upstream_failed', upstreamStatus: null };
}

export function decideSshResult({ audited, outcome, knownValues }: { readonly audited: AuditedExecution; readonly outcome: SshExecOutcome | null; readonly knownValues: readonly string[] }): SshExecutionResult {
  if (!audited.ok) return { ok: false, reason: 'audit_unavailable' };
  if (outcome === null) return { ok: false, reason: 'refused' };
  if (!audited.outcomeRecorded) return { ok: false, reason: 'outcome_unrecorded' };
  if (outcome.kind === 'failed') {
    if (outcome.sent) return { ok: false, reason: 'outcome_unknown' };
    if (outcome.reason === 'host_key_mismatch') return { ok: false, reason: 'host_key_changed' };
    if (outcome.reason === 'auth_failed') return { ok: false, reason: 'key_not_accepted' };
    return { ok: false, reason: outcome.reason === 'address_refused' ? 'refused' : 'host_unreachable' };
  }
  const decoder = new TextDecoder('utf-8');
  const stdout = redactKnownValues({ text: decoder.decode(outcome.stdout), knownValues });
  const stderr = redactKnownValues({ text: decoder.decode(outcome.stderr), knownValues });
  return { ok: true, output: { exitCode: outcome.exitCode, signal: outcome.signal, stdout: stdout.text, stderr: stderr.text, truncated: outcome.truncated, redacted: stdout.redacted || stderr.redacted } };
}

/** The key's text, and each line of its armored body, as values to scrub from output. */
export function sshKnownValues(privateKey: string): readonly string[] {
  const lines = privateKey.split('\n').map((line) => line.trim()).filter((line) => line.length >= 16 && !line.startsWith('-----'));
  return [privateKey.trim(), ...lines];
}
