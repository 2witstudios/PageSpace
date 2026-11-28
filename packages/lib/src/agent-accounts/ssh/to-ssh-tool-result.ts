/**
 * `toSshToolResult` — what the `ssh_exec` tool hands the model (slice 5).
 * Pure. Never a key, never the host's key: the command's output (scrubbed by
 * the plane), its exit code, an approval request carrying what the approval
 * card renders, or a refusal with guidance the model can act on.
 */
import type { SshCommandResult } from '../account-authority-executor';
import type { ApprovalSubject } from '../canonical-request';
import type { RequestDigest } from '../grant';

export type SshToolResult =
  | {
      readonly ok: true;
      readonly accountId: string;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly truncated: boolean;
      readonly redacted: boolean;
    }
  | {
      readonly ok: false;
      readonly accountId: string;
      readonly error: 'approval_required';
      readonly message: string;
      readonly approval: { readonly accountId: string; readonly requestDigest: RequestDigest; readonly subject: ApprovalSubject; readonly stepUp: boolean };
    }
  | { readonly ok: false; readonly accountId: string; readonly error: string; readonly message: string };

const MESSAGES: Readonly<Record<string, string>> = {
  account_unavailable: 'No SSH account with that id is available to this agent in this conversation.',
  kind_not_supported: 'That account is not an SSH account; use http_request for API accounts.',
  not_provisioned: 'This SSH account is not ready yet; ask the person who added it to check it.',
  request_refused: 'The command was refused before running: it must be non-empty, without NUL characters, at most 8 KB (input at most 256 KB).',
  out_of_scope: 'This command is outside what this account is allowed to do.',
  limits_exceeded: 'This account has reached its hourly command limit for now.',
  policy_expired: "This account's standing permission has expired; a person must approve commands again.",
  refused: 'The credential plane refused to run this command.',
  host_unreachable: 'The server could not be reached; the command did not run. You may try again.',
  host_key_changed: "The server presented a different host key than the one the person confirmed, so nothing was sent. This can mean the server was rebuilt — or that someone is impersonating it. Tell the person; do not retry.",
  key_not_accepted: "The server did not accept this account's key. The person needs to add the account's public key (shown in the account settings) to the server's ~/.ssh/authorized_keys for that user.",
  outcome_unknown: 'The command may have run but no result came back (it may still be running). Do not retry automatically; ask the person how to proceed.',
  outcome_unrecorded: 'The command ran, but its outcome could not be recorded, so it is not reported as success. Do not retry automatically; ask the person.',
  audit_unavailable: 'The command did not run because it could not be recorded first. You may try again later.',
  plane_unavailable: 'The credential service is unavailable; the command did not run. You may try again later.',
};

export function toSshToolResult({ accountId, result }: { readonly accountId: string; readonly result: SshCommandResult }): SshToolResult {
  if (result.ok) return { ok: true, accountId, ...result.output };
  if (result.reason === 'approval_required') {
    return {
      ok: false,
      accountId,
      error: 'approval_required',
      message: 'A person must approve this exact command first. Ask them to approve it in the card shown, then run the identical command again.',
      approval: { accountId, requestDigest: result.digest, subject: result.subject, stepUp: result.stepUp },
    };
  }
  return { ok: false, accountId, error: result.reason, message: MESSAGES[result.reason] ?? 'The command was not run.' };
}
