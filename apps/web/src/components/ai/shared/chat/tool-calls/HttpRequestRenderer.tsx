'use client';

import React, { memo, useState } from 'react';
import { KeyRound, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { post } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';

/** The server-rendered approval subject (ADR 0004 §3.3) — derived from the canonical request, never model text. */
export type HttpRequestApprovalSubject = {
  readonly headline?: string;
  readonly origin?: string;
  readonly path?: string;
  readonly query?: readonly (readonly [string, string])[];
  readonly operation?: { readonly class?: string; readonly name?: string };
  readonly bodySha256?: string;
  readonly bodyBytes?: number;
  readonly headerNames?: readonly string[];
};

export type HttpRequestToolOutput = {
  readonly ok?: boolean;
  readonly accountId?: string;
  readonly status?: number;
  readonly body?: string | null;
  readonly bodyOmitted?: string | null;
  readonly truncated?: boolean;
  readonly redacted?: boolean;
  readonly error?: string;
  readonly message?: string;
  readonly rule?: string;
  readonly approval?: { readonly accountId: string; readonly requestDigest: string; readonly subject: HttpRequestApprovalSubject; readonly stepUp: boolean };
};

type HttpRequestRendererProps = {
  readonly method?: string;
  readonly url?: string;
  readonly output: HttpRequestToolOutput;
};

/** The approval card: a person approves THIS exact request (its digest) once, from their own session. */
function ApprovalCard({ approval }: { readonly approval: NonNullable<HttpRequestToolOutput['approval']> }) {
  const [state, setState] = useState<'idle' | 'sending' | 'approved' | 'failed'>('idle');
  const { subject } = approval;
  const approve = async () => {
    setState('sending');
    try {
      await post('/api/agent-accounts/approvals', { accountId: approval.accountId, requestDigest: approval.requestDigest });
      setState('approved');
    } catch {
      setState('failed');
    }
  };
  return (
    <div className="rounded-lg border border-amber-300/60 bg-amber-50/60 dark:bg-amber-950/20 p-3 my-2 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldAlert className="h-4 w-4 text-amber-600" />
        Approve this request?
      </div>
      {subject.headline && <div className="text-xs">{subject.headline}</div>}
      <div className="text-xs font-mono break-all">
        {subject.origin}
        {subject.path}
      </div>
      {subject.query && subject.query.length > 0 && (
        <ul className="text-xs font-mono">
          {subject.query.map(([name, value], index) => (
            <li key={`${name}-${index}`}>
              {name} = {value}
            </li>
          ))}
        </ul>
      )}
      <div className="text-xs text-muted-foreground">
        {subject.bodyBytes ? `Body: ${subject.bodyBytes} bytes. ` : ''}
        The account&apos;s key is added by PageSpace&apos;s credential service; the agent never sees it. Approving allows this one request once.
      </div>
      {approval.stepUp ? (
        <div className="text-xs text-muted-foreground">This operation needs a stronger confirmation that is not available here yet.</div>
      ) : state === 'approved' ? (
        <div className="flex items-center gap-1 text-xs text-green-700 dark:text-green-400">
          <ShieldCheck className="h-3.5 w-3.5" /> Approved. Ask the agent to send the same request again.
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={approve} disabled={state === 'sending'}>
            Approve once
          </Button>
          {state === 'failed' && <span className="text-xs text-destructive">Could not record the approval.</span>}
        </div>
      )}
    </div>
  );
}

/**
 * HttpRequestRenderer — the result of an `http_request` call made with an agent account (G2).
 * Shows the filtered response the plane released, an approval card when a person must approve the
 * exact request, or the refusal's guidance. Never shows a credential: none is ever in the result.
 */
export const HttpRequestRenderer: React.FC<HttpRequestRendererProps> = memo(function HttpRequestRenderer({ method, url, output }) {
  if (output.error === 'approval_required' && output.approval) return <ApprovalCard approval={output.approval} />;
  const ok = output.ok === true;
  return (
    <div className="rounded-lg border bg-card overflow-hidden my-2 shadow-sm">
      <div className="flex items-center gap-2 px-3 py-2 border-b text-xs">
        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-semibold">{method}</span>
        <span className="font-mono truncate">{url}</span>
        {ok && <span className={cn('ml-auto rounded px-1.5 py-0.5', (output.status ?? 0) < 400 ? 'bg-green-100 dark:bg-green-900/40' : 'bg-red-100 dark:bg-red-900/40')}>{output.status}</span>}
      </div>
      {ok ? (
        <div className="p-3 space-y-1">
          {output.body ? <pre className="text-xs whitespace-pre-wrap break-all max-h-72 overflow-auto">{output.body}</pre> : <div className="text-xs text-muted-foreground">{output.bodyOmitted === 'binary' ? 'Binary response (not shown).' : 'Empty response.'}</div>}
          {(output.truncated || output.redacted) && (
            <div className="text-xs text-muted-foreground">
              {output.truncated ? 'Response truncated. ' : ''}
              {output.redacted ? 'Credential-like values were removed.' : ''}
            </div>
          )}
        </div>
      ) : (
        <div className="p-3 text-xs text-muted-foreground">
          {output.message ?? 'The request was not completed.'}
          {output.rule ? ` (${output.rule})` : ''}
        </div>
      )}
    </div>
  );
});
