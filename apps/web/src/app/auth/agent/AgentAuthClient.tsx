'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Bot, Loader2 } from 'lucide-react';
import { AuthLayout } from '@/components/auth';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MarketingLink } from '@/components/ui/MarketingLink';
import { useAuthCSRF } from '@/hooks/useAuthCSRF';
import { useAuthStore } from '@/stores/useAuthStore';
import { persistCsrfToken } from '@/lib/utils/persist-csrf-token';
import { solvePowInBrowser } from '@/lib/agent-auth/pow/solve-in-browser';
import { agentAuthHref, type AgentAuthMode } from '@/components/agent-auth/AgentAuthLink';
import { AgentSecretReveal } from '@/components/agent-auth/AgentSecretReveal';
import { describeAgentAuthError, modeFromParam } from './agent-auth-copy';

interface AgentAuthClientProps {
  /** Already validated on the server. */
  nextPath?: string;
}

type Revealed = { agentId: string; secret: string; claimToken: string; redirectUrl: string; sessionStarted: boolean };

type SignupResponse = {
  agentId: string;
  secret: string;
  claimToken: string;
  redirectUrl: string;
  sessionStarted?: false;
  deviceToken?: string;
};

type SigninResponse = { agentId: string; redirectUrl: string; deviceToken?: string };

type ErrorBody = { error?: string; retryAfter?: number };

const numberFormat = new Intl.NumberFormat('en-US');

/** Mirrors the passkey flow's post-session bookkeeping so silent recovery works for agents too. */
function rememberSession(deviceToken: string | undefined): void {
  persistCsrfToken();
  useAuthStore.getState().setAuthFailedPermanently(false);
  if (!deviceToken) return;
  try {
    localStorage.setItem('deviceToken', deviceToken);
  } catch {
    // Private browsing or quota: never block sign-in.
  }
}

async function devicePlatformFields(): Promise<{ platform: 'web'; deviceId: string; deviceName: string }> {
  const { getOrCreateDeviceId, getDeviceName } = await import('@/lib/analytics');
  return { platform: 'web', deviceId: getOrCreateDeviceId(), deviceName: getDeviceName() };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

function navigate(url: string): void {
  window.location.href = url;
}

function SignupForm({ nextPath, onRevealed }: { nextPath?: string; onRevealed: (revealed: Revealed) => void }) {
  const { csrfToken, refreshToken } = useAuthCSRF();
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [tosAccepted, setTosAccepted] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!csrfToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      setProgress('Requesting a proof-of-work challenge…');
      const challengeRes = await fetch('/api/agent/challenge', { cache: 'no-store' });
      if (!challengeRes.ok) {
        setError(describeAgentAuthError(challengeRes.status, await readJson<ErrorBody>(challengeRes), 'signup'));
        return;
      }
      const challenge = await readJson<{ challenge: string; difficulty_bits: number }>(challengeRes);

      setProgress('Proving work in the background…');
      const nonce = await solvePowInBrowser({
        challenge: challenge.challenge,
        difficultyBits: challenge.difficulty_bits,
        onProgress: (attempts, expected) =>
          setProgress(`Proving work… ${numberFormat.format(attempts)} hashes tried (about ${numberFormat.format(expected)} expected)`),
      });

      setProgress('Creating your agent account…');
      const freshCsrf = (await refreshToken()) ?? csrfToken;
      const response = await fetch('/api/auth/agent/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          ...(source.trim() && { source: source.trim() }),
          tosAccepted,
          pow: { challenge: challenge.challenge, nonce },
          csrfToken: freshCsrf,
          ...(await devicePlatformFields()),
          ...(nextPath && { next: nextPath }),
        }),
      });
      if (!response.ok) {
        setError(describeAgentAuthError(response.status, await readJson<ErrorBody>(response), 'signup'));
        return;
      }
      const data = await readJson<SignupResponse>(response);
      const sessionStarted = data.sessionStarted !== false;
      if (sessionStarted) rememberSession(data.deviceToken);
      onRevealed({ agentId: data.agentId, secret: data.secret, claimToken: data.claimToken, redirectUrl: data.redirectUrl, sessionStarted });
    } catch {
      setError('Could not finish the proof of work. Try again.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Create an agent account">
      <div className="space-y-1.5">
        <Label htmlFor="agent-name">Agent name</Label>
        <Input id="agent-name" name="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Research assistant" autoComplete="off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="agent-source">Which agent are you? (optional)</Label>
        <Input id="agent-source" name="source" maxLength={120} value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. claude-code, codex, chatgpt-agent" autoComplete="off" />
      </div>
      <div className="flex items-start gap-2">
        <Checkbox id="agent-tos" checked={tosAccepted} onCheckedChange={(value) => setTosAccepted(value === true)} />
        <Label htmlFor="agent-tos" className="text-sm font-normal leading-snug">
          I accept the{' '}
          <MarketingLink href="/terms" className="underline">Terms</MarketingLink> and{' '}
          <MarketingLink href="/privacy" className="underline">Privacy Policy</MarketingLink>
        </Label>
      </div>
      <Button type="submit" className="w-full" disabled={!csrfToken || busy || !name.trim() || !tosAccepted}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Bot className="mr-2 h-4 w-4" aria-hidden="true" />}
        Create agent account
      </Button>
      <p aria-live="polite" data-testid="agent-pow-progress" className="min-h-[1.25rem] text-center text-xs text-muted-foreground">
        {progress}
      </p>
      {error && <p role="alert" className="text-center text-sm text-destructive">{error}</p>}
    </form>
  );
}

function SigninForm({ nextPath }: { nextPath?: string }) {
  const { csrfToken, refreshToken } = useAuthCSRF();
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!csrfToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      const freshCsrf = (await refreshToken()) ?? csrfToken;
      const response = await fetch('/api/auth/agent/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: secret.trim(),
          csrfToken: freshCsrf,
          ...(await devicePlatformFields()),
          ...(nextPath && { next: nextPath }),
        }),
      });
      if (!response.ok) {
        setError(describeAgentAuthError(response.status, await readJson<ErrorBody>(response), 'signin'));
        return;
      }
      const data = await readJson<SigninResponse>(response);
      rememberSession(data.deviceToken);
      setSecret('');
      navigate(data.redirectUrl);
    } catch {
      setError('Could not sign in. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Sign in with an agent secret">
      <div className="space-y-1.5">
        <Label htmlFor="agent-secret">Agent secret</Label>
        <Input id="agent-secret" name="secret" type="password" required autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="ps_agent_…" />
      </div>
      <Button type="submit" className="w-full" disabled={!csrfToken || busy || !secret.trim()}>
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
        Sign in as agent
      </Button>
      {error && <p role="alert" className="text-center text-sm text-destructive">{error}</p>}
    </form>
  );
}

/**
 * `/auth/agent` — the browser door for computer-use agents (Agent Signup
 * Phase 3, US2). `?mode=signup` creates an agent account (proof of work in a
 * web worker, then a once-only secret reveal); `?mode=signin` signs in with the
 * secret. Both forms wait for the login-CSRF token.
 */
export function AgentAuthClient({ nextPath }: AgentAuthClientProps) {
  const searchParams = useSearchParams();
  const mode = modeFromParam(searchParams.get('mode'));
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  if (revealed) {
    return (
      <AuthLayout>
        <AgentSecretReveal {...revealed} onContinue={navigate} />
      </AuthLayout>
    );
  }

  const other: AgentAuthMode = mode === 'signup' ? 'signin' : 'signup';
  return (
    <AuthLayout>
      <div className="mb-6 space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">
          {mode === 'signup' ? 'Create an AI agent account' : 'Sign in as an AI agent'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {mode === 'signup'
            ? 'For AI agents acting on their own: no email needed. Agent accounts start with no AI credits; a human can claim yours and fund it later.'
            : 'Paste the agent secret you saved when this agent account was created.'}
        </p>
      </div>

      {mode === 'signup' ? <SignupForm nextPath={nextPath} onRevealed={setRevealed} /> : <SigninForm nextPath={nextPath} />}

      <div className="mt-6 space-y-1 text-center text-sm text-muted-foreground">
        <p>
          {mode === 'signup' ? 'Already have an agent secret? ' : 'New agent? '}
          <Link href={agentAuthHref(other, nextPath)} className="font-medium underline">
            {mode === 'signup' ? 'Sign in' : 'Create an agent account'}
          </Link>
        </p>
        <p>
          Not an AI agent?{' '}
          <Link href="/auth/signin" className="underline">Sign in as a person</Link>
        </p>
      </div>
    </AuthLayout>
  );
}
