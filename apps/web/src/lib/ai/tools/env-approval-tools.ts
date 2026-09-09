import { tool } from 'ai';
import { z } from 'zod';

/**
 * `request_env_approval` — the Tier B click, as a tool (GA wave 2, leaf 5).
 *
 * When a request reaches a LOCAL environment whose machine froze it under a
 * challenge (`local_approval_required` from the sandbox tool runners), the
 * agent calls this tool with the challenge id and STOPS. The chat renders an
 * approval card that fetches the frozen request from the server — the exact
 * normalised command, working directory, environment and limits the MACHINE
 * signed — and the environment's OWNER clicks Allow or Deny. The click
 * re-issues the request to the machine as a fresh grant carrying a
 * server-signed approval intent; the machine byte-compares it against what it
 * froze and runs it only on a match. The outcome comes back as this tool's
 * result and the turn resumes.
 *
 * **Deliberately NOT `ask_user`.** An `ask_user` answer is model-visible free
 * text; it is not an authorization artefact and nothing may treat it as one.
 * Here the authorization never passes through the model or the tool output at
 * all: it is the owner's authenticated click at `POST /api/env-bridge/approvals/
 * <challengeId>`, checked against `drive_env_local.ownerId`, then signed by
 * the server and verified by the machine. The tool output only REPORTS what
 * happened. A test asserts this module never imports the ask_user module.
 *
 * Client-side: no `execute`. Injected at route level ONLY when the session is
 * bound to a local environment, and — exactly as `ask_user` — kept out of
 * `baseTools`, the `tool_search` catalog and the `execute_tool` dispatch map.
 */
export const REQUEST_ENV_APPROVAL_TOOL_NAME = 'request_env_approval';

export const requestEnvApprovalInputSchema = z.object({
  challengeId: z
    .string()
    .min(1)
    .max(128)
    .describe('The challengeId from the local_approval_required tool result, verbatim.'),
});

export type RequestEnvApprovalInput = z.infer<typeof requestEnvApprovalInputSchema>;

/** The scopes the owner may choose on the card; mirrors `APPROVAL_SCOPES` in the pure core. */
export const ENV_APPROVAL_SCOPES = ['once', 'session', '30d', 'until_revoked'] as const;
export type EnvApprovalScope = (typeof ENV_APPROVAL_SCOPES)[number];

/**
 * The output the CLIENT submits when the owner has answered (validated on the
 * server before it is merged into the persisted assistant message, exactly
 * like an ask_user answer; the length caps bound what a client can inject
 * into model context). `outcome` is what the SERVER answered the click with;
 * `exitCode`/`stdout`/`stderr` are the command's own output when it ran.
 */
export const requestEnvApprovalOutputSchema = z
  .object({
    challengeId: z.string().min(1).max(128),
    outcome: z.enum(['allowed', 'denied', 'expired', 'mismatch', 'unknown', 'not_owner', 'failed']),
    scope: z.enum(ENV_APPROVAL_SCOPES).optional(),
    exitCode: z.number().int().optional(),
    stdout: z.string().max(200_000).optional(),
    stderr: z.string().max(50_000).optional(),
    truncated: z.boolean().optional(),
    error: z.string().max(2_000).optional(),
  })
  .strict();

export type RequestEnvApprovalOutput = z.infer<typeof requestEnvApprovalOutputSchema>;

export const envApprovalTools = {
  [REQUEST_ENV_APPROVAL_TOOL_NAME]: tool({
    description:
      'Ask the local environment\'s owner to approve a request the machine has frozen. Use it ONLY when a sandbox tool ' +
      'answered reason local_approval_required with a challengeId; pass that challengeId verbatim. The owner sees the exact ' +
      'command the machine froze and clicks Allow or Deny in the chat; the machine then runs exactly that request, or nothing. ' +
      'After calling this tool, STOP — do not call finish or any other tool; your turn ends and resumes when the owner answers. ' +
      'The result reports the outcome (allowed | denied | expired | mismatch | unknown | not_owner | failed) and, when it ran, ' +
      'the command\'s exit code and output. Do not retry or rephrase the original command while an approval is pending.',
    inputSchema: requestEnvApprovalInputSchema,
  }),
};
