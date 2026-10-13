import Link from 'next/link';
import { MarketingLink } from '@/components/ui/MarketingLink';
import {
  V3_ACCENT,
  V3_BUTTON_PRIMARY,
  V3_BUTTON_SECONDARY,
  V3_FINE,
  V3_H1,
  V3_LEAD,
  V3_LINK,
  V3_STRONG,
  V3_TILE,
} from '@/components/auth/authCardV3';
import type { InviteResolution } from '@/lib/auth/invite-resolver';

interface InviteCardV3Props {
  resolution: InviteResolution;
  token: string;
}

const TERMS_LINE = (
  <p className={V3_FINE}>
    By continuing, you agree to PageSpace’s{' '}
    <MarketingLink href="/terms" className={V3_LINK}>Terms</MarketingLink>
    {' '}and{' '}
    <MarketingLink href="/privacy" className={V3_LINK}>Privacy Policy</MarketingLink>.
  </p>
);

const ICON_INVITE = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M3 15h18M7 18h.01" />
  </svg>
);

const ICON_PAGE = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4M9 12h6M9 16h6" />
  </svg>
);

const ICON_CONNECTION = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5" />
    <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.2 2.5 3.6 5.2" />
  </svg>
);

const ICON_INVALID = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
);

/**
 * v3 invite card for /invite/[token]. Renders inside AuthLayout (AuthFrame) only when
 * Imago is enabled. Consumes the same resolution the classic page uses.
 */
export function InviteCardV3({ resolution, token }: InviteCardV3Props) {
  if (!resolution.ok) {
    return (
      <div>
        <span className="mb-5 grid size-11 place-items-center rounded-xl bg-[oklch(0.15_0.01_220/0.05)] text-[oklch(0.48_0.015_220)]">{ICON_INVALID}</span>
        <h1 className={V3_H1}>This invite is no longer valid</h1>
        <p className={V3_LEAD}>
          The invitation link has expired or already been used. Ask the person who invited you to send a new one.
        </p>
        <Link href="/auth/signin" className={`${V3_BUTTON_SECONDARY} mt-6`}>
          Go to sign in
        </Link>
      </div>
    );
  }

  const { data } = resolution;
  const encodedToken = encodeURIComponent(token);

  if (data.kind === 'page') {
    const ctaHref = data.isExistingUser
      ? `/auth/signin?invite=${encodedToken}`
      : `/auth/signup?invite=${encodedToken}`;
    const ctaLabel = data.isExistingUser ? 'Sign in to access' : 'Create account & access';
    return (
      <div>
        <span className={V3_TILE}>{ICON_PAGE}</span>
        <h1 className={V3_H1}>
          <span className={V3_ACCENT}>{data.inviterName}</span> has shared a page with you
        </h1>
        <p className={V3_LEAD}>
          <strong className={V3_STRONG}>&ldquo;{data.pageTitle}&rdquo;</strong> in{' '}
          <strong className={V3_STRONG}>{data.driveName}</strong> was shared with{' '}
          <strong className={V3_STRONG}>{data.email}</strong>.
        </p>
        <div className="mt-[22px] mb-3.5">{TERMS_LINE}</div>
        <Link href={ctaHref} className={V3_BUTTON_PRIMARY}>{ctaLabel}</Link>
        <p className={`${V3_FINE} mt-3.5`}>
          Not {data.email}? Sign out of any other account first, then return to this link.
        </p>
      </div>
    );
  }

  if (data.kind === 'connection') {
    const ctaHref = data.isExistingUser
      ? `/auth/signin?invite=${encodedToken}`
      : `/auth/signup?invite=${encodedToken}`;
    const ctaLabel = data.isExistingUser ? 'Sign in to connect' : 'Create account & connect';
    return (
      <div>
        <span className={V3_TILE}>{ICON_CONNECTION}</span>
        <h1 className={V3_H1}>
          <span className={V3_ACCENT}>{data.inviterName}</span> wants to connect with you
        </h1>
        <p className={V3_LEAD}>
          This invitation was sent to <strong className={V3_STRONG}>{data.email}</strong>.
        </p>
        {data.message && (
          <p className={`${V3_LEAD} italic`}>&ldquo;{data.message}&rdquo;</p>
        )}
        <div className="mt-[22px] mb-3.5">{TERMS_LINE}</div>
        <Link href={ctaHref} className={V3_BUTTON_PRIMARY}>{ctaLabel}</Link>
        <p className={`${V3_FINE} mt-3.5`}>
          Not {data.email}? Sign out of any other account first, then return to this link.
        </p>
      </div>
    );
  }

  // kind === 'drive'
  const ctaHref = data.isExistingUser
    ? `/auth/signin?invite=${encodedToken}`
    : `/auth/signup?invite=${encodedToken}`;
  const ctaLabel = data.isExistingUser ? 'Sign in to join' : 'Create account & join';
  return (
    <div>
      <span className={V3_TILE}>{ICON_INVITE}</span>
      <h1 className={V3_H1}>
        You’re invited to <span className={V3_ACCENT}>{data.driveName}</span>
      </h1>
      <p className={V3_LEAD}>
        <strong className={V3_STRONG}>{data.inviterName}</strong> invited{' '}
        <strong className={V3_STRONG}>{data.email}</strong> to join as a{' '}
        <strong className={V3_STRONG}>{data.role.toLowerCase()}</strong>.
      </p>
      <div className="mt-[22px] mb-3.5">{TERMS_LINE}</div>
      <Link href={ctaHref} className={V3_BUTTON_PRIMARY}>{ctaLabel}</Link>
      <p className={`${V3_FINE} mt-3.5`}>
        Not {data.email}? Sign out of any other account first, then return to this link.
      </p>
    </div>
  );
}
