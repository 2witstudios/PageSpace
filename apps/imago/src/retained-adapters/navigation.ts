'use client';

import { useMemo } from 'react';
import { IMAGO_BASE_PATH } from '@/lib/auth/sign-in-url';
import { useRouter as useNextRouter, usePathname as useNextPathname } from 'next/navigation';
export { useParams, useSearchParams, notFound, redirect, useSelectedLayoutSegment, useSelectedLayoutSegments } from 'next/navigation';

/** Translate retained UI destinations, leaving API, preview and public URLs alone. */
export function imagoHref(href: string): string {
  const suffixAt = href.search(/[?#]/);
  const path = suffixAt === -1 ? href : href.slice(0, suffixAt);
  const query = suffixAt === -1 ? '' : href.slice(suffixAt);
  if (path === '/dashboard') return '/' + query;
  if (path === '/settings' || path.startsWith('/settings/')) return href.replace('/settings', '/account');
  if (!href.startsWith('/dashboard/')) return href;
  const segments = path.slice('/dashboard/'.length).split('/');
  const [first, second, ...rest] = segments;
  let destination: string;
  if (first === 'channels' && second) destination = `/p/${second}`;
  else if (['channels', 'tasks', 'calendar', 'activity', 'trash'].includes(first)) destination = `/account/${first === 'channels' ? 'messages' : first}`;
  else if (first === 'agents') destination = '/account/agents';
  else if (first === 'dms') destination = `/dm${second ? `/${second}` : ''}`;
  else if (['connections', 'storage', 'drives'].includes(first)) destination = `/account/${first}`;
  else if (!second) destination = `/${first}`;
  else if (second === 'channels') destination = `/${first}/messages${rest.length ? `/${rest.join('/')}` : ''}`;
  else if (['files', 'tasks', 'settings', 'calendar', 'agents', 'workflows', 'activity', 'trash', 'members'].includes(second)) destination = `/${segments.join('/')}`;
  else destination = `/${first}/files/${second}${rest.length ? `/${rest.join('/')}` : ''}`;
  return destination + (query ?? '');
}

/** Browser links and API return paths need the basePath, unlike Next router destinations. */
export function imagoBrowserPath(href: string): string {
  const path = href.split(/[?#]/, 1)[0];
  if (path === IMAGO_BASE_PATH || path.startsWith(`${IMAGO_BASE_PATH}/`)) return href;
  const translated = imagoHref(href);
  return translated === '/' ? IMAGO_BASE_PATH : `${IMAGO_BASE_PATH}${translated}`;
}

export function useRouter() {
  const router = useNextRouter();
  return useMemo(() => ({
    ...router,
    push: (href: string, options?: Parameters<typeof router.push>[1]) => router.push(imagoHref(href), options),
    replace: (href: string, options?: Parameters<typeof router.replace>[1]) => router.replace(imagoHref(href), options),
    prefetch: (href: string, options?: Parameters<typeof router.prefetch>[1]) => router.prefetch(imagoHref(href), options),
  }), [router]);
}

/** Retained readers see their established route grammar; writes translate back. */
export function classicPathname(pathname: string): string {
  if (pathname === '/') return '/dashboard';
  const globalSection = pathname.split('/')[2];
  if (pathname.startsWith('/account/') && ['messages', 'tasks', 'calendar', 'activity', 'trash'].includes(globalSection)) return `/dashboard/${globalSection === 'messages' ? 'channels' : globalSection}`;
  if (pathname === '/account/agents') return '/dashboard/agents';
  if (pathname === '/account' || pathname.startsWith('/account/')) return pathname.replace('/account', '/settings');
  if (pathname === '/dm' || pathname.startsWith('/dm/')) return pathname.replace('/dm', '/dashboard/dms');
  if (pathname.startsWith('/p/')) return pathname;
  const [drive, section, ...rest] = pathname.split('/').filter(Boolean);
  if (!drive) return '/dashboard';
  if (section === 'files' && rest.length) return `/dashboard/${drive}/${rest.join('/')}`;
  return `/dashboard/${drive}${section ? `/${section === 'messages' ? 'channels' : section}` : ''}${rest.length ? `/${rest.join('/')}` : ''}`;
}

export function usePathname() {
  return classicPathname(useNextPathname());
}
