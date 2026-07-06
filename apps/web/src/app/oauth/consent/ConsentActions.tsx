'use client';

import { useEffect, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { post } from '@/lib/auth/auth-fetch';
import {
  buildConsentActionBinding,
  readStepUpTokenFromHash,
  stripStepUpTokenFromHash,
  isNoPasskeyError,
} from './consent-step-up';

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

  // A step-up magic link redirects back to this same consent URL with the
  // grant attached in the fragment (never the query string, which would hit
  // server logs) — pick it up on load and scrub it from the visible URL.
  useEffect(() => {
    const tokenFromEmail = readStepUpTokenFromHash(window.location.hash);
    if (!tokenFromEmail) return;
    setStepUpToken(tokenFromEmail);
    setStepUpStatus('ready');
    const cleanedHash = stripStepUpTokenFromHash(window.location.hash);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${cleanedHash}`);
  }, []);

  async function runWebauthnStepUp(): Promise<string> {
    const { options } = await post<{ options: { challenge: string }; challengeId: string }>(
      '/api/auth/step-up/webauthn/options',
      { actionBinding },
    );
    const webauthnResponse = await startAuthentication({ optionsJSON: options as never });
    const { stepUpToken: token } = await post<{ stepUpToken: string }>('/api/auth/step-up/webauthn/verify', {
      response: webauthnResponse,
      expectedChallenge: options.challenge,
      actionBinding,
    });
    return token;
  }

  async function requestMagicLinkStepUp(): Promise<void> {
    const next = `${window.location.pathname}${window.location.search}`;
    await post('/api/auth/step-up/magic-link/request', { actionBinding, next });
  }

  async function decide(action: 'approve' | 'deny') {
    setIsSubmitting(true);
    setError(null);
    try {
      let token = stepUpToken;

      if (action === 'approve' && !token) {
        setStepUpStatus('in_progress');
        try {
          token = await runWebauthnStepUp();
        } catch (ceremonyError) {
          if (isNoPasskeyError(ceremonyError)) {
            await requestMagicLinkStepUp();
            setStepUpStatus('awaiting_email');
            setIsSubmitting(false);
            return;
          }
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
