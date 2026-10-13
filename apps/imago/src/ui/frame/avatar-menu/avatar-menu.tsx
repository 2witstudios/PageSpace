'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { signOut } from '@/lib/auth/sign-out';
import { ThemeSwitcher } from '../../components/theme-switcher/theme-switcher';
import { useDisclosure } from '../disclosure/use-disclosure';
import { renderAvatarMenu } from './avatar-menu.render';

/** apps/web's profile route (apps/web/src/app/api/auth/me/route.ts). */
export const ME = '/api/auth/me';

export type Profile = { readonly name: string | null; readonly image: string | null };

/**
 * The name and picture from /api/auth/me. The route already drops external
 * pictures; anything but a same-origin path is dropped here too, so the
 * avatar never loads from another origin.
 */
export const profileFrom = (body: unknown): Profile => {
  if (typeof body !== 'object' || body === null) return { name: null, image: null };
  const { name, image } = body as { readonly name?: unknown; readonly image?: unknown };
  return {
    name: typeof name === 'string' && name.trim() !== '' ? name : null,
    image: typeof image === 'string' && image.startsWith('/') && !image.startsWith('//') ? image : null,
  };
};

/** The avatar menu, bound to the viewer's profile, the page's theme and web's logout. */
export function AvatarMenu() {
  const { data } = useSWR<unknown>(ME);
  const { open, setOpen, ref } = useDisclosure();
  const [signingOut, setSigningOut] = useState(false);
  const { name, image } = profileFrom(data);

  const onSignOut = () => {
    setSigningOut(true);
    void signOut({
      fetch: (input, init) => window.fetch(input, init),
      navigate: (url) => window.location.assign(url),
    });
  };

  return renderAvatarMenu({
    name,
    image,
    open,
    onToggle: setOpen,
    onPick: () => setOpen(false),
    theme: <ThemeSwitcher />,
    onSignOut,
    signingOut,
    detailsRef: ref,
  });
}
