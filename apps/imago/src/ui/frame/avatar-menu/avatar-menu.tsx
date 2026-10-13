'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { signOut } from '@/lib/auth/sign-out';
import { FeedbackDialog } from '@/retained/components/shared/FeedbackDialog';
import { ThemeSwitcher } from '../../components/theme-switcher/theme-switcher';
import { CREDITS } from '../../chat/spend-strip/spend-strip-model';
import { useDisclosure } from '../disclosure/use-disclosure';
import { useVerifyEmail } from '../banners/verify-email-banner';
import { creditsCardOf } from './avatar-menu-model';
import { renderAvatarMenu } from './avatar-menu.render';

/** apps/web's profile route (apps/web/src/app/api/auth/me/route.ts). */
export const ME = '/api/auth/me';

export type Profile = {
  readonly name: string | null;
  readonly email: string | null;
  readonly image: string | null;
  /** null until the profile loads, or when the route did not say. */
  readonly emailVerified: boolean | null;
};

/**
 * The name, email, picture and verification state from /api/auth/me. The route already drops
 * external pictures; anything but a same-origin path is dropped here too, so the avatar never
 * loads from another origin.
 */
export const profileFrom = (body: unknown): Profile => {
  if (typeof body !== 'object' || body === null) return { name: null, email: null, image: null, emailVerified: null };
  const { name, email, image, emailVerified } = body as {
    readonly name?: unknown;
    readonly email?: unknown;
    readonly image?: unknown;
    readonly emailVerified?: unknown;
  };
  return {
    name: typeof name === 'string' && name.trim() !== '' ? name : null,
    email: typeof email === 'string' && email.trim() !== '' ? email : null,
    image: typeof image === 'string' && image.startsWith('/') && !image.startsWith('//') ? image : null,
    emailVerified: typeof emailVerified === 'boolean' ? emailVerified : null,
  };
};

/**
 * The avatar menu, bound to the viewer's profile, the credit balance, the page's theme, the
 * feedback dialog, the verify-email action and web's logout.
 * `active`: the account is open, so the avatar carries the spine's ring.
 */
export function AvatarMenu({ active = false }: { readonly active?: boolean } = {}) {
  const { data } = useSWR<unknown>(ME);
  const { data: creditsBody } = useSWR<unknown>(CREDITS);
  const { open, setOpen, ref } = useDisclosure();
  const [signingOut, setSigningOut] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { resend } = useVerifyEmail();
  const profile = profileFrom(data);

  const onSignOut = () => {
    setSigningOut(true);
    void signOut({
      fetch: (input, init) => window.fetch(input, init),
      navigate: (url) => window.location.assign(url),
    });
  };

  return (
    <>
      {renderAvatarMenu({
        name: profile.name,
        email: profile.email,
        image: profile.image,
        open,
        onToggle: setOpen,
        onPick: () => setOpen(false),
        theme: <ThemeSwitcher />,
        onSignOut,
        signingOut,
        credits: creditsCardOf(creditsBody),
        onFeedback: () => setFeedbackOpen(true),
        verifyEmail: profile.emailVerified === false ? { onVerify: () => { setOpen(false); void resend(); } } : null,
        detailsRef: ref,
        active,
      })}
      <FeedbackDialog isOpen={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </>
  );
}
