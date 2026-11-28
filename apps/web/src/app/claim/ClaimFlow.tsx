'use client';

import { useState } from 'react';
import { post } from '@/lib/auth/auth-fetch';
import { isV3AuthEnabled } from '@/lib/imago/v3-auth-enabled';
import {
  V3_BODY,
  V3_ERROR_TEXT,
  V3_HEADING,
  V3_PRIMARY_BUTTON,
  V3_SECONDARY_BUTTON,
} from '@/components/auth/auth-v3-styles';

interface VerifyResponse {
  userCode: string;
  agent: { name: string; createdAt: string; source: string | null };
}

type Step =
  | { name: 'entry' }
  | { name: 'consent'; data: VerifyResponse }
  | { name: 'done'; action: 'approve' | 'deny'; agentName: string };

interface ClaimFlowProps {
  initialUserCode: string;
}

/** The HTTP status an `ApiRequestError` carries; read structurally so a mocked fetch layer works too. */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null;
  return typeof error.status === 'number' ? error.status : null;
}

function formatCreated(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * The agent-claim screen (ADR 0008, Agent Signup Phase 4), mirroring
 * ActivateFlow: enter code → verify (session-gated, rate-limited) → a consent
 * that names the agent and says plainly that the human will pay for its AI
 * usage → approve/deny (CSRF-protected) → confirmation. Every step re-hits the
 * server; nothing here is trusted client-side state.
 */
export function ClaimFlow({ initialUserCode }: ClaimFlowProps) {
  const [userCode, setUserCode] = useState(initialUserCode);
  const [step, setStep] = useState<Step>({ name: 'entry' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v3 = isV3AuthEnabled();
  // Classic mode: the page renders the h1; v3: this flow is the page heading.
  const Heading = v3 ? 'h1' : 'h2';

  async function verify() {
    setIsSubmitting(true);
    setError(null);
    try {
      const data = await post<VerifyResponse>('/api/agent/claim/verify', { userCode });
      setStep({ name: 'consent', data });
    } catch (verifyError) {
      setError(
        statusOf(verifyError) === 403
          ? 'Only a person can claim an agent. Sign in with your own account.'
          : 'That code is invalid or has expired.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function decide(action: 'approve' | 'deny', data: VerifyResponse) {
    setIsSubmitting(true);
    setError(null);
    try {
      await post('/api/agent/claim/decision', { userCode: data.userCode, action });
      setStep({ name: 'done', action, agentName: data.agent.name });
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (step.name === 'done') {
    const claimed = step.action === 'approve';
    const heading = claimed ? 'Agent claimed' : 'Not claimed';
    const message = claimed
      ? `You now own ${step.agentName}. Its AI usage is billed to you from now on. Manage it in Settings → Agents.`
      : 'The agent was not claimed. You may close this window.';
    return (
      <div className={v3 ? undefined : 'mt-8'}>
        <Heading className={v3 ? V3_HEADING : 'text-lg font-semibold'}>{heading}</Heading>
        <p className={v3 ? V3_BODY : 'mt-2 text-sm'}>{message}</p>
      </div>
    );
  }

  if (step.name === 'consent') {
    const { data } = step;
    const rowClass = v3
      ? 'flex justify-between gap-4 px-3.5 py-3 text-[13.5px] text-[oklch(0.15_0.01_220)]'
      : 'flex justify-between gap-4 px-3 py-2 text-sm';
    return (
      <div className={v3 ? undefined : 'mt-8'}>
        <Heading className={v3 ? V3_HEADING : 'text-lg font-semibold'}>Claim this agent</Heading>
        <dl className={v3 ? 'mt-6 overflow-hidden rounded-xl border border-[oklch(0.90_0.005_230)] bg-[oklch(0.995_0.002_240)] divide-y' : 'mt-4 rounded border divide-y'}>
          <div className={rowClass}>
            <dt className="text-muted-foreground">Name</dt>
            <dd className="font-medium">{data.agent.name}</dd>
          </div>
          <div className={rowClass}>
            <dt className="text-muted-foreground">Created</dt>
            <dd>{formatCreated(data.agent.createdAt)}</dd>
          </div>
          <div className={rowClass}>
            <dt className="text-muted-foreground">Source</dt>
            <dd>{data.agent.source ?? 'Not stated'}</dd>
          </div>
        </dl>
        <p className={v3 ? V3_BODY : 'mt-4 text-sm'}>
          <strong>You will pay for its AI usage.</strong> Once you claim it, every AI call this agent makes is billed to
          your account at your plan. The agent keeps its own identity, drives and keys; you can revoke or unlink it any
          time from Settings → Agents.
        </p>
        {error && <p className={v3 ? V3_ERROR_TEXT : 'mt-3 text-sm text-destructive'}>{error}</p>}
        <div className={v3 ? 'mt-6 flex flex-col gap-3' : 'mt-6 flex gap-3'}>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => decide('approve', data)}
            className={v3 ? V3_PRIMARY_BUTTON : 'flex-1 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50'}
          >
            Claim and pay
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => decide('deny', data)}
            className={v3 ? V3_SECONDARY_BUTTON : 'flex-1 rounded border px-4 py-2 text-sm font-medium disabled:opacity-50'}
          >
            Deny
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={v3 ? 'flex flex-col' : 'mt-8'}>
      {v3 && (
        <>
          <h1 className={V3_HEADING}>Claim an agent</h1>
          <p className={V3_BODY}>Enter the code your AI agent gave you. You will be asked to confirm before anything changes.</p>
        </>
      )}
      <label htmlFor="claim-user-code" className={v3 ? 'mt-6 block text-sm font-medium' : 'block text-sm font-medium'}>
        Agent code
      </label>
      <input
        id="claim-user-code"
        type="text"
        autoCapitalize="characters"
        autoComplete="off"
        value={userCode}
        onChange={(e) => setUserCode(e.target.value)}
        placeholder="XXXX-XXXX"
        className={v3
          ? "mt-2 h-10 w-full rounded-[10px] border border-[oklch(0.90_0.005_230)] bg-[oklch(0.995_0.002_240)] px-3 font-['Geist_Mono',monospace] text-sm uppercase tracking-[0.08em]"
          : 'mt-2 w-full rounded border px-3 py-2 text-sm'}
      />
      {error && <p role="alert" className={v3 ? V3_ERROR_TEXT : 'mt-3 text-sm text-destructive'}>{error}</p>}
      <button
        type="button"
        disabled={isSubmitting || userCode.trim().length === 0}
        onClick={verify}
        className={v3 ? `mt-6 ${V3_PRIMARY_BUTTON}` : 'mt-4 w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50'}
      >
        Continue
      </button>
    </div>
  );
}
