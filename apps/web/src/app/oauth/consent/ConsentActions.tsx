'use client';

import { useEffect, useRef, useState } from 'react';
import { post } from '@/lib/auth/auth-fetch';
import { attemptStepUp, readStepUpTokenFromHash, stripStepUpTokenFromHash } from '@/lib/auth/step-up-ceremony';
import { buildConsentActionBinding } from './consent-step-up';

interface ConsentActionsProps {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state: string | undefined;
}

type StepUpStatus = 'idle' | 'in_progress' | 'awaiting_email' | 'ready';

/**
 * `redirect_uri` is an arbitrary loopback origin (`http://127.0.0.1:<port>`) —
 * `fetch()` cannot navigate the top-level browsing context there, so the
 * approve/deny decision is a CSRF-protected JSON POST (matching every other
 * mutation in this app) and this component performs the actual navigation
 * once the server hands back the validated target.
 *
 * Allow additionally requires a live step-up grant (Phase 8 credential
 * minting security correction): a WebAuthn tap for users with a passkey, or
 * a fresh single-use magic link to their own inbox otherwise. Neither can be
 * extracted from a stolen session cookie and replayed later. Denying never
 * needs a step-up — it only narrows access.
 */
export function ConsentActions(props: ConsentActionsProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUpStatus, setStepUpStatus] = useState<StepUpStatus>('idle');
  const [stepUpToken, setStepUpToken] = useState<string | null>(null);

  const actionBinding = buildConsentActionBinding(props);
  const emailResumeStarted = useRef(false);

  // A step-up magic link redirects back to this same consent URL with the
  // grant attached in the fragment (never the query string, which would hit
  // server logs) — pick it up on load, scrub it from the visible URL, and
  // resume the approval automatically. The grant can only exist because the
  // user already clicked Allow here AND clicked the emailed confirmation
  // link (and it is single-use and server-bound to these exact consent
  // params), so asking for a second Allow click would be pure friction —
  // for the CLI login flow it risked the user waiting out the CLI's timeout
  // on a screen that looked like it still needed nothing from them.
  useEffect(() => {
    const tokenFromEmail = readStepUpTokenFromHash(window.location.hash);
    if (!tokenFromEmail) return;
    // Effects can run twice (StrictMode); the grant is single-use, so the
    // resume must fire exactly once.
    if (emailResumeStarted.current) return;
    emailResumeStarted.current = true;
    setStepUpToken(tokenFromEmail);
    setStepUpStatus('ready');
    const cleanedHash = stripStepUpTokenFromHash(window.location.hash);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${cleanedHash}`);
    void decide('approve', tokenFromEmail);
    // decide is stable for the lifetime of this mount-only effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function decide(action: 'approve' | 'deny', emailGrantToken?: string) {
    setIsSubmitting(true);
    setError(null);
    try {
      let token = emailGrantToken ?? stepUpToken;

      if (action === 'approve' && !token) {
        setStepUpStatus('in_progress');
        try {
          const next = `${window.location.pathname}${window.location.search}`;
          const result = await attemptStepUp(actionBinding, next);
          if (result.status === 'awaiting_email') {
            setStepUpStatus('awaiting_email');
            setIsSubmitting(false);
            return;
          }
          token = result.stepUpToken;
        } catch (ceremonyError) {
          // Any ceremony failure (most commonly the user dismissing or
          // cancelling the browser's WebAuthn prompt, or the magic-link
          // request itself failing) must not leave the button stuck showing
          // "Confirming…" — explicitly drop back to idle and clear any token
          // so a retry starts a genuinely fresh ceremony. The outer catch
          // below still surfaces the user-facing error and re-enables the
          // buttons.
          setStepUpStatus('idle');
          setStepUpToken(null);
          throw ceremonyError;
        }
        setStepUpToken(token);
        setStepUpStatus('ready');
      }

      const { redirectUri } = await post<{ redirectUri: string }>('/api/oauth/authorize', {
        clientId: props.clientId,
        redirectUri: props.redirectUri,
        responseType: props.responseType,
        codeChallenge: props.codeChallenge,
        codeChallengeMethod: props.codeChallengeMethod,
        scope: props.scope,
        state: props.state,
        action,
        ...(action === 'approve' ? { stepUpToken: token } : {}),
      });
      window.location.href = redirectUri;
    } catch {
      // The step-up grant is single-use: whether or not the authorize call
      // consumed it before failing, it must not be retried. Drop back to a
      // clean slate so the next Allow click runs a genuinely fresh ceremony.
      setStepUpToken(null);
      setStepUpStatus('idle');
      setError('Something went wrong. Please try again.');
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

  return (
    <div className="mt-8">
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <div className="flex gap-3">
        <button
          type="button"
          disabled={isSubmitting}
          onClick={() => decide('approve')}
          className="flex-1 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {stepUpStatus === 'in_progress' ? 'Confirming…' : 'Allow'}
        </button>
        <button
          type="button"
          disabled={isSubmitting}
          onClick={() => decide('deny')}
          className="flex-1 rounded border px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
