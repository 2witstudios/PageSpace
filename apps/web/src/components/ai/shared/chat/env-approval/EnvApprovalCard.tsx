import React, { useEffect, useMemo, useState } from 'react';
import { ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useAskUserAnswerContext } from '../ask-user/AskUserAnswerContext';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import {
  ENV_APPROVAL_SCOPES,
  REQUEST_ENV_APPROVAL_TOOL_NAME,
  type EnvApprovalScope,
  type RequestEnvApprovalOutput,
} from '@/lib/ai/tools/env-approval-tools';

/**
 * The Tier B approval card (GA wave 2, leaf 5): the environment owner's
 * click on a request the MACHINE froze.
 *
 * What it shows is fetched from `GET /api/env-bridge/approvals/<challengeId>`
 * — the frozen request as the machine signed it (principal, op, argv, cwd,
 * paths, env, limits: the same fields the daemon's terminal prompt renders),
 * never the model's paraphrase and never the tool input. Allow / Deny call
 * `POST` on the same route; the server re-issues the identical request with
 * the owner's signed intent and the machine byte-compares before it runs.
 * The route's answer is submitted as the tool result so the turn resumes.
 *
 * This card never reuses `ask_user`: the click is an authenticated request
 * to the server, not text the model reads. A test asserts this file does not
 * import the ask_user module.
 */

interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
  input?: unknown;
  output?: unknown;
}

interface EnvApprovalCardProps {
  part: ToolPart;
}

interface FrozenRequest {
  op: string;
  cmd?: string;
  args?: string[];
  cwd: string;
  paths: string[];
  env: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  clamped: boolean;
}

interface PendingApprovalView {
  challengeId: string;
  envId: string;
  principal: { userId: string; sessionId: string; conversationId: string };
  expiresAt: number;
  request: FrozenRequest;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; pending: PendingApprovalView }
  | { kind: 'gone'; outcome: 'expired' | 'not_owner' | 'unknown'; message: string };

const tryJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const challengeIdOf = (input: unknown): string | null => {
  const parsed = typeof input === 'string' ? tryJson(input) : input;
  const id = parsed && typeof parsed === 'object' ? (parsed as { challengeId?: unknown }).challengeId : undefined;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

const outputOf = (value: unknown): RequestEnvApprovalOutput | null => {
  const parsed = typeof value === 'string' ? tryJson(value) : value;
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { outcome?: unknown }).outcome !== 'string') return null;
  return parsed as RequestEnvApprovalOutput;
};

export const SCOPE_LABELS: Record<EnvApprovalScope, string> = {
  once: 'This once',
  session: 'Until the daemon stops',
  '30d': 'For 30 days',
  until_revoked: 'Until I revoke it',
};

/** Exactly the lines `renderAskPrompt` prints on the daemon, as rows. */
export function frozenRequestRows(pending: PendingApprovalView): Array<[string, string]> {
  const { request, principal } = pending;
  const rows: Array<[string, string]> = [
    ['principal', `user ${principal.userId}, session ${principal.sessionId}, conversation ${principal.conversationId}`],
    ['op', request.op],
  ];
  if (request.cmd !== undefined) rows.push(['command', [request.cmd, ...(request.args ?? [])].join(' ')]);
  rows.push(['cwd', request.cwd]);
  if (request.paths.length > 0) rows.push(['paths', request.paths.join(', ')]);
  const env = Object.entries(request.env).map(([name, value]) => `${name}=${value}`);
  rows.push(['env', env.length > 0 ? env.join(' ') : '(none)']);
  rows.push(['limits', `timeout ${request.timeoutMs} ms, output ${request.maxBytes} bytes${request.clamped ? ' (clamped to the machine policy)' : ''}`]);
  return rows;
}

async function fetchPending(challengeId: string): Promise<LoadState> {
  // Through the auth fetch helper (Codex P1 on #2583): it carries the session and the CSRF token the POST route requires; a raw fetch answered 403 CSRF_TOKEN_MISSING.
  const response = await fetchWithAuth(`/api/env-bridge/approvals/${encodeURIComponent(challengeId)}`, { method: 'GET' });
  if (response.ok) {
    const pending = (await response.json()) as PendingApprovalView;
    return { kind: 'loaded', pending };
  }
  const body = (await response.json().catch(() => ({}))) as { outcome?: string; error?: string };
  const outcome = body.outcome === 'not_owner' ? 'not_owner' : body.outcome === 'unknown' ? 'unknown' : 'expired';
  return { kind: 'gone', outcome, message: body.error ?? `The pending approval could not be loaded (${response.status}).` };
}

export function EnvApprovalCard({ part }: EnvApprovalCardProps) {
  const answerContext = useAskUserAnswerContext();
  const challengeId = useMemo(() => challengeIdOf(part.input), [part.input]);
  const answered = useMemo(() => outputOf(part.output), [part.output]);
  const answerable = Boolean(answerContext && part.toolCallId && answerContext.answerableToolCallIds.has(part.toolCallId)) && part.state === 'input-available';

  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [scope, setScope] = useState<EnvApprovalScope>('30d');
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (answered !== null || challengeId === null) return;
    let cancelled = false;
    fetchPending(challengeId)
      .then((state) => {
        if (!cancelled) setLoad(state);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ kind: 'gone', outcome: 'unknown', message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [challengeId, answered]);

  const submit = (output: RequestEnvApprovalOutput) => {
    if (!answerContext || !part.toolCallId) return;
    answerContext.submitAnswers(part.toolCallId, output, REQUEST_ENV_APPROVAL_TOOL_NAME);
  };

  const decide = async (decision: 'allow' | 'deny') => {
    if (challengeId === null || busy !== null) return;
    setBusy(decision);
    setFailure(null);
    try {
      const response = await fetchWithAuth(`/api/env-bridge/approvals/${encodeURIComponent(challengeId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(decision === 'allow' ? { decision, scope } : { decision }),
      });
      const body = (await response.json().catch(() => null)) as RequestEnvApprovalOutput | { error?: string; outcome?: string } | null;
      const outcome = body && typeof body === 'object' && typeof (body as { outcome?: unknown }).outcome === 'string' ? (body as RequestEnvApprovalOutput).outcome : 'failed';
      const output: RequestEnvApprovalOutput = body && 'challengeId' in body && typeof body.challengeId === 'string' ? (body as RequestEnvApprovalOutput) : { challengeId, outcome, error: (body as { error?: string } | null)?.error ?? `HTTP ${response.status}` };
      submit(output);
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  if (challengeId === null) {
    return (
      <div className="my-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <span className="font-medium">Approval request without a challenge id.</span> Nothing was sent to the machine.
      </div>
    );
  }

  if (answered !== null) {
    const ok = answered.outcome === 'allowed';
    const Icon = ok ? ShieldCheck : answered.outcome === 'denied' ? ShieldX : ShieldAlert;
    return (
      <div className={cn('my-2 rounded-lg border p-3 text-sm', ok ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-muted bg-muted/30')} data-testid="env-approval-answered">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4" aria-hidden />
          <span className="font-medium">
            {ok ? 'Approved and run on your machine' : answered.outcome === 'denied' ? 'Denied' : `Not run (${answered.outcome})`}
          </span>
          {answered.scope && ok ? <Badge variant="secondary">{SCOPE_LABELS[answered.scope]}</Badge> : null}
        </div>
        {ok && answered.exitCode !== undefined ? <div className="mt-1 text-xs text-muted-foreground">exit code {answered.exitCode}{answered.truncated ? ' · output truncated' : ''}</div> : null}
        {answered.error ? <div className="mt-1 text-xs text-muted-foreground">{answered.error}</div> : null}
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-testid="env-approval-card">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-600" aria-hidden />
        <span className="font-medium">Your machine is asking for your approval</span>
        <Badge variant="outline">local environment</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        The machine froze this exact request. Allowing runs it as you, on your computer, with whatever it does once started; nothing else runs.
      </p>

      {load.kind === 'loading' ? <div className="mt-2 text-xs text-muted-foreground">Loading the frozen request…</div> : null}
      {load.kind === 'gone' ? (
        <div className="mt-2 text-xs" data-testid="env-approval-gone">
          {load.message}
          {answerable ? (
            <div className="mt-2">
              <Button size="sm" variant="secondary" onClick={() => submit({ challengeId, outcome: load.outcome, error: load.message })}>
                Tell the agent
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {load.kind === 'loaded' ? (
        <>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs" data-testid="env-approval-request">
            {frozenRequestRows(load.pending).map(([label, value]) => (
              <React.Fragment key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all whitespace-pre-wrap">{value}</dd>
              </React.Fragment>
            ))}
          </dl>
          {answerable ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="text-xs text-muted-foreground" htmlFor={`env-approval-scope-${part.toolCallId}`}>
                Remember for
              </label>
              <select
                id={`env-approval-scope-${part.toolCallId}`}
                className="rounded border bg-background px-2 py-1 text-xs"
                value={scope}
                onChange={(event) => setScope(event.target.value as EnvApprovalScope)}
                disabled={busy !== null}
              >
                {ENV_APPROVAL_SCOPES.map((value) => (
                  <option key={value} value={value}>
                    {SCOPE_LABELS[value]}
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={() => void decide('allow')} disabled={busy !== null} data-testid="env-approval-allow">
                {busy === 'allow' ? 'Sending…' : 'Allow'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void decide('deny')} disabled={busy !== null} data-testid="env-approval-deny">
                {busy === 'deny' ? 'Sending…' : 'Deny'}
              </Button>
            </div>
          ) : (
            <div className="mt-2 text-xs text-muted-foreground">Waiting for the machine owner.</div>
          )}
          {failure ? <div className="mt-2 text-xs text-destructive">{failure}</div> : null}
        </>
      ) : null}
    </div>
  );
}
