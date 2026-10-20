// Which body the Members pane shows, read from the URL (C-Members, C-Members-Profile, C-Members-Invite).
// The pathname is basePath-relative, as next/navigation's usePathname returns it.

export type MembersPaneVariant =
  | { readonly kind: 'overview' }
  | { readonly kind: 'profile'; readonly userId: string }
  | { readonly kind: 'invite' };

/** `/<driveId>/members` and `/<driveId>/members/all` are the overview; `/<driveId>/members/invite` the invite; `/<driveId>/members/<userId>` a profile. */
export function membersVariantFor(pathname: string | null | undefined): MembersPaneVariant {
  const [, section, id] = (pathname ?? '').split('/').filter(Boolean);
  if (section !== 'members') return { kind: 'overview' };
  if (id === undefined || id === 'all') return { kind: 'overview' };
  if (id === 'invite') return { kind: 'invite' };
  return { kind: 'profile', userId: decodeURIComponent(id) };
}
