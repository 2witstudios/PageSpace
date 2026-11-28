'use client';

/**
 * The one-time enrollment handoff for a LOCAL environment (Local Environments
 * epic, [D-3]): the code, the exact commands to run on the machine, when the
 * code stops working, and — in the words the founder approved for the CLI
 * README — what the person is agreeing to.
 *
 * Shared by the two places a code is ever shown: the spawn palette right after
 * a local create, and the sidebar row's "Show a new code" (a server re-issue
 * for an env whose machine has not enrolled). The code is rendered from the
 * response that carried it and from nothing else; there is no endpoint that
 * returns an existing code, only one that replaces it.
 */

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';

/** What a local create or a re-issue hands back ONCE (`localEnvEnrollmentIssueSchema`). */
export interface LocalEnvEnrollmentIssue {
  enrollmentId: string;
  code: string;
  /** ISO-8601. */
  expiresAt: string;
}

/** The full boundary statement, as merged in #2555 — linked rather than pasted into a dialog. */
const CLI_BOUNDARY_DOCS_URL = 'https://github.com/2witstudios/PageSpace/blob/master/packages/cli/README.md#what-you-are-agreeing-to';

/**
 * The two commands, in the order and with the flags `packages/cli/README.md`
 * documents. `--host` is given explicitly on both: the daemon resolves its host
 * per command (`--host`, else `PAGESPACE_API_URL`, else the default), and a
 * self-hosted or preview deployment is not the default.
 */
function enrollmentCommands({ host, enrollmentId, code }: { host: string; enrollmentId: string; code: string }): string {
  return `pagespace env enroll ${enrollmentId} ${code} --host ${host}\npagespace env connect ${enrollmentId} --host ${host}`;
}

/** Where this app is served from — the host the machine must dial. Never a hardcoded string. */
function useAppOrigin(): string {
  const [origin] = useState(() => (typeof window === 'undefined' ? '' : window.location.origin));
  return origin;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-input px-2 py-1 text-xs hover:bg-accent"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error('Could not copy', { description: 'Select the text and copy it by hand.' });
        }
      }}
    >
      {copied ? <Check className="size-3" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

export function LocalEnvEnrollmentPanel({
  envName,
  machineLabel,
  enrollment,
}: {
  envName: string;
  machineLabel: string;
  enrollment: LocalEnvEnrollmentIssue;
}) {
  const host = useAppOrigin();
  const commands = enrollmentCommands({ host, enrollmentId: enrollment.enrollmentId, code: enrollment.code });
  const expires = new Date(enrollment.expiresAt);
  const minutesLeft = Math.max(0, Math.round((expires.getTime() - Date.now()) / 60_000));
  const expiresLabel = expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="space-y-4 text-sm" data-testid="enrollment-panel">
      <p className="text-muted-foreground">
        “{envName}” is a local environment: sessions in it run on {machineLabel}, not in a cloud sandbox. On that
        computer, install the PageSpace CLI if you have not (<code className="text-xs">npm install -g @pagespace/cli</code>), then run:
      </p>
      {/* Said BEFORE the commands, because the first one succeeds anywhere: on
          Windows `env enroll` would pin this environment to a machine that
          `env connect` refuses (t08 gated the daemon to POSIX), and an enrolled
          environment can never be issued another code. */}
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">macOS and Linux only.</span> The bridge daemon does not run on
        Windows. Do not enrol from a Windows machine: enrolling would tie this environment to a computer that cannot
        connect, and it could not then be moved to another one.
      </p>

      <div className="space-y-1.5">
        <pre
          data-testid="enrollment-commands"
          className="overflow-x-auto rounded-md border border-input bg-muted/40 p-2 font-mono text-xs leading-relaxed"
        >
          {commands}
        </pre>
        <div className="flex justify-end">
          <CopyButton text={commands} label="Copy commands" />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium text-muted-foreground">Enrollment code</div>
        <div className="flex items-center gap-2">
          <code
            data-testid="enrollment-code"
            className="flex-1 select-all rounded-md border border-input bg-muted/40 px-2 py-1.5 font-mono text-sm tracking-wider"
          >
            {enrollment.code}
          </code>
          <CopyButton text={enrollment.code} label="Copy code" />
        </div>
        <p className="text-xs text-muted-foreground">
          It works once and expires at {expiresLabel} ({minutesLeft} {minutesLeft === 1 ? 'minute' : 'minutes'} from now). If you
          lose it, choose <span className="font-medium">Show a new code</span> from the environment’s menu in the sidebar.
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">What you are agreeing to.</span> Everything runs as you, on your computer,
        with no sandbox: anything your account can reach, an agent driving this environment can reach. In <code>ask</code> mode,
        approving one command also covers every later command of that kind for the rest of that session, without showing it to
        you.{' '}
        <a href={CLI_BOUNDARY_DOCS_URL} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
          Read the full statement
        </a>{' '}
        before you enrol.
      </p>
    </div>
  );
}
