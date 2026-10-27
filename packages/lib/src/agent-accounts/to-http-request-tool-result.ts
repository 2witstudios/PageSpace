/**
 * `toHttpRequestToolResult` — what the `http_request` tool returns to the model
 * (L2·G2; epic invariant 1, reference never value). Pure.
 *
 * The operation result is already the plane's filtered view; this adds only
 * the account id the model named and fixed guidance per refusal. It never adds
 * anything about the account (kind, origins, owner) — a refusal for an account
 * the caller may not use reads exactly like one for an account that does not
 * exist. An unrecorded or unknown outcome says so plainly: the request may have
 * run, it is not success, and it must not be retried automatically.
 */
import type { AccountOperationResult } from './account-authority-executor';
import type { ApprovalSubject, CanonicalizeRefusal } from './canonical-request';
import type { RequestDigest } from './grant';

export type HttpRequestToolResult =
  | {
      readonly ok: true;
      readonly accountId: string;
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string | null;
      readonly bodyOmitted: null | 'empty' | 'binary';
      readonly truncated: boolean;
      readonly redacted: boolean;
      /** Request headers the canonical request did not carry, so they were never sent (lowercase, sorted). */
      readonly droppedHeaders?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly accountId: string;
      readonly error: 'approval_required';
      readonly message: string;
      readonly approval: { readonly accountId: string; readonly requestDigest: RequestDigest; readonly subject: ApprovalSubject; readonly stepUp: boolean };
    }
  | { readonly ok: false; readonly accountId: string; readonly error: 'request_refused' | 'destination_denied'; readonly rule: CanonicalizeRefusal | string; readonly message: string }
  | { readonly ok: false; readonly accountId: string; readonly error: string; readonly message: string };

const MESSAGES: Readonly<Record<string, string>> = {
  account_unavailable: 'No account with that id is available to this agent in this conversation.',
  kind_not_supported: 'This account type cannot be used for HTTP requests yet.',
  not_provisioned: 'This account is not ready yet; ask the person who added it to check it.',
  refused: 'The credential plane refused this request.',
  upstream_unreachable: 'The site could not be reached; nothing was sent. You may try again.',
  outcome_unknown: 'The request may have reached the site but no response came back. Do not retry automatically; ask the person how to proceed.',
  outcome_unrecorded: 'The request ran, but its outcome could not be recorded, so it is not reported as success. Do not retry automatically; ask the person how to proceed.',
  audit_unavailable: 'The request was not sent because it could not be recorded first. You may try again later.',
  plane_unavailable: 'The credential service is unavailable; nothing was sent. You may try again later.',
  out_of_scope: 'This request is outside what this account is allowed to do.',
  limits_exceeded: 'This account has reached its usage limit for now.',
  class_never_always: 'This kind of operation needs a person to approve it each time.',
  policy_expired: "This account's standing permission has expired; a person must approve requests again.",
  request_refused: 'The request was refused before sending; fix the named rule (for example, never set Authorization, Cookie or Host yourself — the account supplies credentials).',
  destination_denied: "The request targets an address outside this account's allowed origins; nothing was sent.",
};

export function toHttpRequestToolResult({
  accountId,
  result,
  droppedHeaders = [],
}: {
  readonly accountId: string;
  readonly result: AccountOperationResult;
  /** Header names the request asked for that the canonical request does not project (never digested, never sent). */
  readonly droppedHeaders?: readonly string[];
}): HttpRequestToolResult {
  if (result.ok) {
    const { response } = result;
    const dropped = [...new Set(droppedHeaders.map((name) => name.toLowerCase()))].sort();
    return {
      ...(dropped.length > 0 ? { droppedHeaders: dropped } : {}),
      ok: true,
      accountId,
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: response.body,
      bodyOmitted: response.bodyOmitted,
      truncated: response.truncated,
      redacted: response.redacted,
    };
  }
  if (result.reason === 'approval_required') {
    return {
      ok: false,
      accountId,
      error: 'approval_required',
      message: 'A person must approve this exact request before it can be sent. Ask them to approve it, then make the identical request again.',
      approval: { accountId, requestDigest: result.digest, subject: result.subject, stepUp: result.stepUp },
    };
  }
  if (result.reason === 'request_refused' || result.reason === 'destination_denied') {
    return { ok: false, accountId, error: result.reason, rule: result.rule, message: MESSAGES[result.reason]! };
  }
  return { ok: false, accountId, error: result.reason, message: MESSAGES[result.reason] ?? 'The request was not completed.' };
}
