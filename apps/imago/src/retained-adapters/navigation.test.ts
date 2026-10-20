import { afterEach, describe, expect, it, vi } from 'vitest';
import { imagoHref, imagoBrowserPath, retainedRouterHref, navigateRetained, classicPathname } from './navigation';
import { stageFor } from '@/ui/frame/stage/stage';

afterEach(() => vi.unstubAllEnvs());

describe('retained destinations stay inside the persistent shell', () => {
  it.each([
    ['/dashboard', '/'],
    ['/settings?tab=profile#name', '/account?tab=profile#name'],
    ['/settings/ai?model=a#config', '/account/ai?model=a#config'],
    ['/dashboard/drive123/page456?tab=code#selection', '/drive123/files/page456?tab=code#selection'],
    ['/dashboard/drive123/channels/page456', '/drive123/messages/page456'],
    ['/dashboard/channels/page456', '/p/page456'],
    ['/dashboard/dms/new', '/dm/new'],
    ['/dashboard/drive123/agents?workspace=w&c=c', '/drive123/agents/view?workspace=w&c=c'],
    ['/dashboard/drive123/calendar?date=2026-10-20', '/drive123/calendar/view?date=2026-10-20'],
    ['/dashboard/drive123/trash', '/drive123/trash/view'],
    ['/dashboard/drive123/members', '/drive123/members/all'],
    ['/dashboard/drive123/members/invite', '/drive123/members/invite'],
    ['/api/pages/page456', '/api/pages/page456'],
    ['https://other.example/dashboard', 'https://other.example/dashboard'],
  ])('maps %s to %s', (source, destination) => expect(imagoHref(source)).toBe(destination));
  it.each([
    ['/dashboard', '/imago'],
    ['/settings/integrations?connected=true#provider', '/imago/account/integrations?connected=true#provider'],
    ['/dashboard/drive123/settings/integrations', '/imago/drive123/settings/integrations'],
    ['/imago/drive123/agents?c=c', '/imago/drive123/agents?c=c'],
    ['/imago?c=c#chat', '/imago?c=c#chat'],
  ])('returns the native callback path for %s', (source, destination) => expect(imagoBrowserPath(source)).toBe(destination));
  it.each([
    ['/auth', 'https://pagespace.ai/auth'],
    ['/auth/signin?next=%2Fimago%2Fdrive123%2Ffiles', 'https://pagespace.ai/auth/signin?next=%2Fimago%2Fdrive123%2Ffiles'],
    ['/dashboard/drive123/page456', '/drive123/files/page456'],
  ])('routes %s without putting public auth under the basePath', (source, destination) => {
    expect(retainedRouterHref(source, 'https://pagespace.ai')).toBe(destination);
  });
  it('uses the configured public auth origin on standalone production deployments', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_WEB_APP_URL', 'http://localhost:3000');
    expect(retainedRouterHref('/auth/signin?next=%2Fimago', 'http://localhost:3006'))
      .toBe('http://localhost:3000/auth/signin?next=%2Fimago');
    expect(retainedRouterHref('/auth/account-deleted?appleSignIn=manual', 'http://localhost:3006'))
      .toBe('http://localhost:3000/auth/account-deleted?appleSignIn=manual');
  });
  it('gives retained path readers their established drive/section shape', () => {
    expect(classicPathname('/drive123/files/page456')).toBe('/dashboard/drive123/page456');
    expect(classicPathname('/drive123/messages/page456')).toBe('/dashboard/drive123/channels/page456');
    expect(classicPathname('/account/ai')).toBe('/settings/ai');
  });
  it('renders cross-drive resolution before a drive has been resolved', () => {
    const stage = stageFor('/p/page456');
    expect(stage.driveId).toBeNull();
    expect(stage.object).not.toBeNull();
  });
});

it.each([
  ['/auth/signin?next=%2Fimago', 'https://pagespace.ai/auth/signin?next=%2Fimago', true],
  ['/dashboard/drive123/page456', '/drive123/files/page456', false],
] as const)('uses the correct navigation transport for %s', (href, destination, auth) => {
  const exit = vi.fn(); const route = vi.fn();
  navigateRetained(href, { origin: 'https://pagespace.ai', exit, route });
  expect(auth ? exit : route).toHaveBeenCalledExactlyOnceWith(destination);
  expect(auth ? route : exit).not.toHaveBeenCalled();
});


it('maps wallet and organization entrypoints to their native destinations', () => {
  expect(imagoHref('/settings/usage/wallets?view=funded')).toBe('/account/wallets?view=funded');
  expect(imagoHref('/settings?createOrg=1')).toBe('/account/organizations?createOrg=1');
  expect(classicPathname('/account/wallets')).toBe('/settings/usage/wallets');
  expect(classicPathname('/orgs/org-1/settings')).toBe('/orgs/org-1/settings');
});

it('org settings use the account shell without a fictitious orgs drive', () => {
  expect(stageFor('/orgs/org-1/settings/members')).toEqual({ driveId: null, section: 'account', list: 'tree', object: { kind: 'account' } });
});

it('a pathname unavailable during hydration does not claim a drive or throw', () => {
  expect(classicPathname(null)).toBe('/dashboard');
});

describe('a tool’s screen reads as classic’s tool route', () => {
  it.each([
    ['/drive123/calendar/view', '/dashboard/drive123/calendar'],
    ['/drive123/agents/view', '/dashboard/drive123/agents'],
    ['/drive123/members/all', '/dashboard/drive123/members'],
    ['/drive123/members/u1', '/dashboard/drive123/members/u1'],
    ['/drive123/calendar', '/dashboard/drive123/calendar'],
  ])('reads %s as %s', (pathname, classic) => expect(classicPathname(pathname)).toBe(classic));
});
