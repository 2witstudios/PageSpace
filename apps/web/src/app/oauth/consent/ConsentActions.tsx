'use client';

import { useState } from 'react';
import { post } from '@/lib/auth/auth-fetch';

interface ConsentActionsProps {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state: string | undefined;
}

/**
 * `redirect_uri` is an arbitrary loopback origin (`http://127.0.0.1:<port>`) —
 * `fetch()` cannot navigate the top-level browsing context there, so the
 * approve/deny decision is a CSRF-protected JSON POST (matching every other
 * mutation in this app) and this component performs the actual navigation
 * once the server hands back the validated target.
 */
export function ConsentActions(props: ConsentActionsProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: 'approve' | 'deny') {
    setIsSubmitting(true);
    setError(null);
    try {
      const { redirectUri } = await post<{ redirectUri: string }>('/api/oauth/authorize', {
        clientId: props.clientId,
        redirectUri: props.redirectUri,
        responseType: props.responseType,
        codeChallenge: props.codeChallenge,
        codeChallengeMethod: props.codeChallengeMethod,
        scope: props.scope,
        state: props.state,
        action,
      });
      window.location.href = redirectUri;
    } catch {
      setError('Something went wrong. Please try again.');
      setIsSubmitting(false);
    }
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
          Allow
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
