/**
 * The owner's terminal prompt for `ask` mode (invariant 5). The daemon asks
 * about a request whose op is not pre-approved in the policy AND that no
 * durable approval covers (`decide-approval.ts`). What the owner sees is
 * EXACTLY the `NormalizedRequest` the `ask` verdict carried — confined cwd
 * and paths, scrubbed env, clamped caps — because that is what
 * `decideExecution` will re-normalize and compare against on approval
 * (`approval_mismatch`).
 *
 * THIS MODULE REMEMBERS NOTHING (GA wave 2, leaf 1). It used to keep a `Set`
 * keyed `(userId, sessionId, op)`, which is why approving `git status` once
 * covered every later `exec` in that session unseen. An approval is now
 * remembered by the dispatcher, in the approvals store, keyed on the
 * SUBJECTS the verdict carried (`exec:/usr/bin/git`, `root:/home/u/proj`)
 * and for the scope the owner chose here — `once`, `session`, `30d` (the
 * default) or `until_revoked`. The prompt says which subjects an approval
 * would cover, or that this request cannot be remembered at all.
 *
 * The prompt primitives are injected: `env connect` supplies
 * `@clack/prompts`' confirm and select; tests supply functions. A prompt
 * that throws (stdin closed) is a decline.
 */
import { DEFAULT_APPROVAL_SCOPE, type ApprovalScope, type GrantOp, type GrantPrincipal } from './lib-core.js';
import type { NormalizedRequest } from './lib-core.js';

export interface AskInput {
  readonly grantId: string;
  readonly principal: GrantPrincipal;
  readonly op: GrantOp;
  readonly request: NormalizedRequest;
  /** What an approval would be remembered under; `null` = it cannot be remembered, the owner is asked every time. */
  readonly subjects: readonly string[] | null;
}

export type AskAnswer = { readonly approved: false } | { readonly approved: true; readonly scope: ApprovalScope };

export interface AskPrompter {
  ask(input: AskInput): Promise<AskAnswer>;
}

export interface AskPrompterDeps {
  readonly confirm: (message: string) => Promise<boolean>;
  /** How long to remember an approval; omitted ⇒ `DEFAULT_APPROVAL_SCOPE`. Only asked when the request has subjects. */
  readonly chooseScope?: (subjects: readonly string[]) => Promise<ApprovalScope>;
  readonly write: (chunk: string) => void;
}

/** A subject as the owner reads it. */
export function describeSubject(subject: string): string {
  if (subject.startsWith('exec:')) return subject.slice('exec:'.length);
  if (subject.startsWith('builtin:')) return `${subject.slice('builtin:'.length)} (shell builtin)`;
  if (subject.startsWith('root:')) return `files under ${subject.slice('root:'.length)}`;
  return subject;
}

export function describeScope(scope: ApprovalScope): string {
  switch (scope) {
    case 'once':
      return 'this request only';
    case 'session':
      return 'until this daemon stops';
    case '30d':
      return 'for 30 days';
    case 'until_revoked':
      return 'until you revoke it';
  }
}

export function renderAskPrompt(input: AskInput): string {
  const { request } = input;
  const lines = [
    `PageSpace asks to run on this machine (grant ${input.grantId}):`,
    `  principal  user ${input.principal.userId}, session ${input.principal.sessionId}, conversation ${input.principal.conversationId}`,
    `  op         ${input.op}`,
  ];
  if (request.cmd !== undefined) lines.push(`  command    ${[request.cmd, ...(request.args ?? [])].join(' ')}`);
  lines.push(`  cwd        ${request.cwd}`);
  if (request.paths.length > 0) lines.push(`  paths      ${request.paths.join(', ')}`);
  const env = Object.entries(request.env).map(([name, value]) => `${name}=${value}`);
  lines.push(`  env        ${env.length > 0 ? env.join(' ') : '(none)'}`);
  lines.push(`  limits     timeout ${request.timeoutMs} ms, output ${request.maxBytes} bytes${request.clamped ? ' (clamped to your policy)' : ''}`);
  if (input.subjects === null) {
    lines.push('This request cannot be remembered (its programs cannot be pinned down): approving covers this request only, and you will be asked again next time.');
  } else {
    lines.push(`Approving covers ${input.op} of: ${input.subjects.map(describeSubject).join(', ')} — for user ${input.principal.userId}, from any chat, for the time you choose next. It never covers other programs.`);
  }
  return lines.join('\n');
}

export function createAskPrompter(deps: AskPrompterDeps): AskPrompter {
  return {
    async ask(input) {
      deps.write(`${renderAskPrompt(input)}\n`);
      let answer = false;
      try {
        answer = await deps.confirm('Allow?');
      } catch {
        answer = false;
      }
      if (!answer) return { approved: false };
      if (input.subjects === null) return { approved: true, scope: 'once' };
      let scope: ApprovalScope = DEFAULT_APPROVAL_SCOPE;
      if (deps.chooseScope !== undefined) {
        try {
          scope = await deps.chooseScope(input.subjects);
        } catch {
          return { approved: false };
        }
      }
      return { approved: true, scope };
    },
  };
}
