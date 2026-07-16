/**
 * Pure input validators for the sandbox git toolkit. Each returns a Result
 * rather than throwing, so a single function wires into both a zod `.refine`
 * (schema layer) and the tool's execute path (defense-in-depth) — killing the
 * ~20 hand-rolled imperative re-checks that used to drift from their schemas.
 * No effects, no imports — every branch is tested in `__tests__/validators.test.ts`.
 */

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * A value starting with "-" passed as a bare positional CLI arg can be
 * reinterpreted as a flag by git/gh's argument parser (e.g. a ref of
 * "--exec=whoami"). Identifier-like params (refs, repo slugs, workflow names)
 * never legitimately start with "-".
 */
export const startsLikeFlag = (value: string): boolean => value.startsWith('-');

/** Reject a value that could be reinterpreted as a flag. `label` names the field. */
export function validateFlagSafe(value: string, label: string): ValidationResult {
  return startsLikeFlag(value)
    ? { ok: false, error: `${label} must not start with "-"` }
    : { ok: true };
}

// A single lowercase commit SHA — no ranges (`a..b`), no refs (`HEAD`), no flags.
const SHA_RE = /^[0-9a-f]{4,40}$/;

export function validateShaOnly(sha: string): ValidationResult {
  return SHA_RE.test(sha)
    ? { ok: true }
    : { ok: false, error: 'sha must be a single lowercase commit SHA (no ranges or refs)' };
}

// workflow_dispatch input keys are interpolated into `-f k=v`, so a key with
// `=`, whitespace or `/` could smuggle extra fields — restrict to a safe charset.
const WORKFLOW_INPUT_NAME_RE = /^[A-Za-z0-9_-]+$/;

export function validateWorkflowInputNames(
  inputs: Record<string, string> | undefined,
): ValidationResult {
  const bad = Object.keys(inputs ?? {}).find((k) => !WORKFLOW_INPUT_NAME_RE.test(k));
  return bad === undefined
    ? { ok: true }
    : {
        ok: false,
        error: `Invalid workflow input name "${bad}" — input names must be alphanumeric/_/-`,
      };
}

// A repo name must start with a letter/digit and otherwise only contain
// letters, digits, ".", "_", "-" — so it can never be read as a flag.
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateRepoName(name: string): ValidationResult {
  return REPO_NAME_RE.test(name)
    ? { ok: true }
    : {
        ok: false,
        error:
          'name must start with a letter or digit and may otherwise contain only letters, digits, ".", "_", and "-"',
      };
}

/** Only https:// URLs are allowed for clones/remotes. `label` names the operation. */
export function assertHttps(url: string, label: string): ValidationResult {
  return url.startsWith('https://')
    ? { ok: true }
    : { ok: false, error: `Only HTTPS URLs are supported for ${label}.` };
}
