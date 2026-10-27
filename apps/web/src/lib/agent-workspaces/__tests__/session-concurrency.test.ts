// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { findDrive, findUser, isLapsed } = vi.hoisted(() => ({ findDrive: vi.fn(), findUser: vi.fn(), isLapsed: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: { query: { drives: { findFirst: findDrive }, users: { findFirst: findUser } } } }));
vi.mock('@pagespace/lib/organizations/status', () => ({ isOrgLapsedForDrive: isLapsed }));
import { checkSessionConcurrency } from '../session-concurrency';

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
  findDrive.mockReset().mockResolvedValue({ ownerId: 'lead', orgId: 'org' });
  findUser.mockReset().mockResolvedValue({ subscriptionTier: 'free' });
  isLapsed.mockReset().mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());
describe('session concurrency entitlement', () => {
  it('WAL-9 (partial) permits an active organization session with a Free lead', async () => {
    expect(await checkSessionConcurrency({ session: { driveId: 'drive', ownerId: 'member' }, ownerId: 'member', countLiveAgentSessions: async () => 0 })).toEqual({ allowed: true });
  });
  it('WAL-9 (partial) denies a lapsed organization even when its lead has Pro', async () => {
    findUser.mockResolvedValue({ subscriptionTier: 'pro' });
    isLapsed.mockResolvedValue(true);
    expect(await checkSessionConcurrency({ session: { driveId: 'drive', ownerId: 'member' }, ownerId: 'member', countLiveAgentSessions: async () => 0 })).toEqual({ allowed: false, reason: 'tier_ineligible' });
  });
  it('refuses a vanished drive without falling back to the member plan', async () => {
    findDrive.mockResolvedValue(undefined);
    findUser.mockResolvedValue({ subscriptionTier: 'pro' });
    expect(await checkSessionConcurrency({ session: { driveId: 'gone', ownerId: 'member' }, ownerId: 'member', countLiveAgentSessions: async () => 0 })).toEqual({ allowed: false, reason: 'tier_ineligible' });
  });
});
