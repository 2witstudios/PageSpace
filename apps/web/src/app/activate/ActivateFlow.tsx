'use client';

import { useEffect, useState } from 'react';
import { post } from '@/lib/auth/auth-fetch';
import { attemptStepUp, readStepUpTokenFromHash, stripStepUpTokenFromHash } from '@/lib/auth/step-up-ceremony';

interface VerifyResponse {
  userCode: string;
  clientName: string;
  firstParty: boolean;
  scopeDescriptions: string[];
  /** True for key-shaped grants (mint / re-scope / activate) — see the decision route. */
  requiresStepUp: boolean;
  stepUpActionBinding: Record<string, string> | null;
}

type Step =
  | { name: 'entry' }
  | { name: 'consent'; data: VerifyResponse }
  | { name: 'done'; action: 'approve' | 'deny' };

type StepUpStatus = 'idle' | 'in_progress' | 'awaiting_email' | 'ready';

interface ActivateFlowProps {
  initialUserCode: string;
}

/**
 * Drives the device-flow verification screen end to end: enter code → verify
 * (rate-limited, session-gated) → render the SAME consent narration task 6's
 * /oauth/consent uses → approve/deny (CSRF-protected) → confirmation. Every
 * step re-hits the server; nothing here is trusted client-side state.
 */
export function ActivateFlow({ initialUserCode }: ActivateFlowProps) {
  const [userCode, setUserCode] = useState(initialUserCode);
  const [step, setStep] = useState<Step>({ name: 'entry' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUpStatus, setStepUpStatus] = useState<StepUpStatus>('idle');
  const [stepUpToken, setStepUpToken] = useState<string | null>(null);

  // A step-up magic link redirects back to /activate?user_code=... with the
  // grant attached in the fragment (never the query string, which would hit
  // server logs) — pick it up on load and scrub it from the visible URL.
  // Mirrors ConsentActions.tsx.
  useEffect(() => {
    const tokenFromEmail = readStepUpTokenFromHash(window.location.hash);
    if (!tokenFromEmail) return;
    setStepUpToken(tokenFromEmail);
    setStepUpStatus('ready');
    const cleanedHash = stripStepUpTokenFromHash(window.location.hash);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${cleanedHash}`);
  }, []);

  async function verify() {
    setIsSubmitting(true);
    setError(null);
    try {
      const data = await post<VerifyResponse>('/api/oauth/device_authorization/verify', { userCode });
      setStep({ name: 'consent', data });
    } catch {
      setError('That code is invalid or has expired.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function decide(action: 'approve' | 'deny', data: VerifyResponse) {
    setIsSubmitting(true);
    setError(null);
    try {
      let token = stepUpToken;

      // Minting a key, re-scoping one, or making one a device's ambient
      // default is a credential escalation and carries the same second factor
      // the browser consent screen demands. A plain login approval skips this
      // entirely, so `login --device` is unchanged.
      if (action === 'approve' && data.requiresStepUp && data.stepUpActionBinding && !token) {
        setStepUpStatus('in_progress');
        try {
          const next = `${window.location.pathname}${window.location.search}`;
          const result = await attemptStepUp(data.stepUpActionBinding, next);
          if (result.status === 'awaiting_email') {
            setStepUpStatus('awaiting_email');
            setIsSubmitting(false);
            return;
          }
          token = result.stepUpToken;
        } catch (ceremonyError) {
          // Never leave the button stuck on "Confirming…" — drop back to idle
          // and clear any token so a retry starts a genuinely fresh ceremony.
          setStepUpStatus('idle');
          setStepUpToken(null);
          throw ceremonyError;
        }
        setStepUpToken(token);
        setStepUpStatus('ready');
      }

      await post('/api/oauth/device_authorization/decision', {
        userCode: data.userCode,
        action,
        ...(action === 'approve' && token ? { stepUpToken: token } : {}),
      });
      setStep({ name: 'done', action });
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (stepUpStatus === 'awaiting_email') {
    return (
      <div className="mt-8">
        <p className="text-sm text-muted-foreground">
          Check your email for a confirmation link to finish approving this request.
        </p>
      </div>
    );
  }

  if (step.name === 'done') {
    return (
      <div className="mt-8">
        <p className="text-sm">
          {step.action === 'approve'
            ? 'Device connected. You may return to your terminal.'
            : 'Access denied. You may close this window.'}
        </p>
      </div>
    );
  }

  if (step.name === 'consent') {
    const { data } = step;
    return (
      <div className="mt-8">
        <h2 className="text-lg font-medium">
          {data.clientName} is requesting access
          {data.firstParty && (
            <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
              Built by PageSpace
            </span>
          )}
        </h2>
        <ul className="mt-4 space-y-3 text-sm">
          {data.scopeDescriptions.map((text, i) => (
            <li key={i} className="rounded border p-3">
              {text}
            </li>
          ))}
        </ul>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => decide('approve', data)}
            className="flex-1 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {stepUpStatus === 'in_progress' ? 'Confirming…' : 'Allow'}
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => decide('deny', data)}
            className="flex-1 rounded border px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            Deny
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8">
      <label htmlFor="user-code" className="block text-sm font-medium">
        Device code
      </label>
      <input
        id="user-code"
        type="text"
        autoCapitalize="characters"
        autoComplete="off"
        value={userCode}
        onChange={(e) => setUserCode(e.target.value)}
        placeholder="XXXX-XXXX"
        className="mt-2 w-full rounded border px-3 py-2 text-sm"
      />
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <button
        type="button"
        disabled={isSubmitting || userCode.trim().length === 0}
        onClick={verify}
        className="mt-4 w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        Continue
      </button>
    </div>
  );
}
